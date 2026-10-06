import { expect, test } from "bun:test"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppRuntime } from "@/effect/app-runtime"
import { enhancePrompt } from "@/kilocode/enhance-prompt"
import { generateCommitMessage } from "@/kilocode/commit-message/generate"
import { provide as provideInstance } from "@/kilocode/instance"
import { tmpdir } from "../../fixture/fixture"
import { failures } from "./standalone-failures.fixture"

const model = { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5-mini") }
const env = ["KILO_EXPERIMENTAL_PROVIDER_PROFILES", "OPENAI_API_KEY", "KILO_AUTH_CONTENT"] as const

test("standalone prompt and commit callers send only account A and fail safely through the real SDK", async () => {
  const prior = Object.fromEntries(env.map((key) => [key, process.env[key]]))
  const fetcher = globalThis.fetch
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.OPENAI_API_KEY = "SECRET_ENV_KEY"
  process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "SECRET_LEGACY_KEY" } })
  const calls: Array<{ url: string; auth: string | null; account: string | null }> = []
  const context = (accountID: string) => ({
    kind: "account" as const,
    providerID: "openai" as const,
    authMode: "chatgpt-oauth" as const,
    accountID,
  })

  await using tmp = await tmpdir({
    git: true,
    config: {
      formatter: false,
      lsp: false,
      provider: {
        openai: {
          id: "openai",
          name: "OpenAI Test",
          npm: "@ai-sdk/openai",
          env: ["OPENAI_API_KEY"],
          models: {
            "gpt-5-mini": {
              id: "gpt-5-mini",
              name: "GPT-5 mini test",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: {},
        },
      },
    },
  })

  const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
  const a = await AppRuntime.runPromise(
    profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "standalone failure A",
      remoteID: "standalone-failure-A",
      credential: {
        access: "SECRET_ACCESS_A",
        refresh: "SECRET_REFRESH_A",
        expires: Date.now() + 60_000,
        accountID: "standalone-failure-A",
      },
    }),
  )
  const b = await AppRuntime.runPromise(
    profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "standalone failure B",
      remoteID: "standalone-failure-B",
      credential: {
        access: "SECRET_ACCOUNT_B",
        refresh: "SECRET_ACCOUNT_B_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "standalone-failure-B",
      },
    }),
  )
  await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))

  try {
    for (const item of failures) {
      for (const caller of ["enhance-prompt", "commit-message"] as const) {
        const before = calls.length
        if ("refresh" in item) {
          const cred = await AppRuntime.runPromise(profiles.credential(a.id))
          if (!cred) throw new Error("profile A credential missing")
          await AppRuntime.runPromise(
            profiles.compareAndSwapCredential({
              id: a.id,
              revision: cred.revision,
              value: { ...cred.value, expires: 0 },
            }),
          )
        }
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = input instanceof Request ? input : undefined
            const url = req?.url ?? (input instanceof URL ? input.href : input)
            const headers = new Headers(req?.headers)
            if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
            const host = new URL(String(url)).hostname
            if (host === "chatgpt.com" || host === "api.openai.com" || host === "auth.openai.com")
              calls.push({
                url: String(url),
                auth: headers.get("authorization"),
                account: headers.get("chatgpt-account-id"),
              })
            if (host === "auth.openai.com" && "refresh" in item)
              return new Response("not-json SECRET_REFRESH_A SECRET_PROVIDER_ERROR", { status: 200 })
            if ("reject" in item) return item.reject()
            if (!("response" in item)) throw new Error("Unexpected transport after malformed refresh response")
            return item.response()
          },
          { preconnect: fetcher.preconnect },
        )

        const result = await provideInstance({
          directory: tmp.path,
          fn: async () => {
            if (caller === "enhance-prompt")
              return enhancePrompt("rewrite this", { model, accountContext: context(a.id) }).then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
              )
            return generateCommitMessage({ path: tmp.path, model, accountContext: context(a.id) }).then(
              () => ({ ok: true as const }),
              (err: unknown) => ({ ok: false as const, err }),
            )
          },
        })
        expect(result.ok, `${caller}: ${item.name}`).toBe(false)
        if (!result.ok && caller === "commit-message")
          expect(result.err).toMatchObject({ message: "Failed to generate commit message" })
        if (!result.ok && caller === "enhance-prompt")
          expect(result.err).toMatchObject({ name: "UtilityAccountError", code: "account-unavailable" })
        if (!result.ok) expect(String(result.err)).not.toContain("SECRET_")
        expect(
          calls.length - before,
          `${caller}: ${item.name}; error=${!result.ok ? String(result.err) : "ok"}`,
        ).toBeGreaterThan(0)
        expect(calls.length - before, `${caller}: ${item.name} request bound`).toBeLessThanOrEqual(4)
        const reqs = calls.slice(before)
        const wire = JSON.stringify(reqs)
        expect(wire).not.toContain("SECRET_ACCOUNT_B")
        expect(wire).not.toContain("SECRET_ENV_KEY")
        expect(wire).not.toContain("SECRET_LEGACY_KEY")
        if ("refresh" in item) {
          expect(reqs.every((call) => call.url === "https://auth.openai.com/oauth/token")).toBe(true)
        } else {
          expect(
            reqs.every((call) => call.auth === "Bearer SECRET_ACCESS_A"),
            JSON.stringify(reqs),
          ).toBe(true)
          expect(
            reqs.every((call) => call.account === "standalone-failure-A"),
            JSON.stringify(reqs),
          ).toBe(true)
        }
        expect(JSON.stringify(calls.slice(before))).not.toContain("SECRET_ACCOUNT_B")
      }
    }
  } finally {
    globalThis.fetch = fetcher
    for (const key of env) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    await AppRuntime.runPromise(profiles.remove(a.id))
    await AppRuntime.runPromise(profiles.remove(b.id))
  }
})
