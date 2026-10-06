import { expect, spyOn, test } from "bun:test"
import { Cause, Effect, Stream } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionNetwork } from "@/session/network"
import { QuestionID } from "@/question/schema"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { KiloSessionProcessor } from "@/kilocode/session/processor"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { createKiloClient } from "@kilocode/sdk/v2"
import { ExportCommand } from "@/cli/cmd/export"
import { EnhancePromptRuntime } from "@/kilocode/enhance-prompt"
import { CommitMessageRuntime } from "@/kilocode/commit-message/generate"
import { provide as provideInstance } from "@/kilocode/instance"
import { ProviderTest } from "../../fake/provider"
import type { Provider } from "@/provider/provider"
import { handle as rollCall } from "@/kilocode/cli/cmd/roll-call"
import { Client } from "../../../../kilo-telemetry/src/client"
import { tmpdir } from "../../fixture/fixture"
import { failures, markers } from "./failure-matrix.fixture"

test("real session HTTP error table pins A and sanitizes persisted, live, replay, export, and telemetry sinks", async () => {
  const prior = {
    flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
    key: process.env.OPENAI_API_KEY,
    auth: process.env.KILO_AUTH_CONTENT,
    fetch: globalThis.fetch,
  }
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.OPENAI_API_KEY = "SECRET_ENV_KEY"
  process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "SECRET_LEGACY_KEY" } })
  const raw = markers.join(" ")
  const userText = "intentional transcript SECRET_AUTH_CONTENT"
  const calls: Array<{ url: string; bearer: string | null; account: string | null }> = []
  const events: unknown[] = []
  const scenarios = failures.filter((item) => "status" in item || "reject" in item || "refresh" in item)
  let current = scenarios[0]!
  const refreshCalls: string[] = []
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
      label: "failure A",
      remoteID: "failure-A",
      credential: {
        access: "SECRET_ACCESS_A",
        refresh: "SECRET_REFRESH_A",
        expires: Date.now() + 60_000,
        accountID: "failure-A",
      },
    }),
  )
  const b = await AppRuntime.runPromise(
    profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "failure B",
      remoteID: "failure-B",
      credential: {
        access: "SECRET_ACCOUNT_B",
        refresh: "SECRET_ACCOUNT_B_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "failure-B",
      },
    }),
  )
  await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname === "auth.openai.com" && "refresh" in current) {
        refreshCalls.push(url.href)
        return new Response(current.raw, { status: 200 })
      }
      if (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com") {
        const headers = new Headers(input instanceof Request ? input.headers : undefined)
        if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
        calls.push({
          url: url.href,
          bearer: headers.get("authorization"),
          account: headers.get("chatgpt-account-id"),
        })
        if ("reject" in current) return current.reject()
        if ("raw" in current) {
          if (!("status" in current)) throw new Error("refresh fixture unexpectedly reached provider transport")
          return new Response(current.raw, { status: current.status })
        }
        if (!("status" in current)) throw new Error("refresh fixture unexpectedly reached provider transport")
        return Response.json("body" in current ? current.body : { error: { message: raw, code: raw } }, {
          status: current.status,
        })
      }
      return prior.fetch(input, init)
    },
    { preconnect: prior.fetch.preconnect },
  )
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const sdk = createKiloClient({ baseUrl: `http://${server.hostname}:${server.port}`, headers: ServerAuth.headers() })
  const off = await AppRuntime.runPromise(
    EventV2.Service.use((service) => service.listen((event) => Effect.sync(() => events.push(event)))),
  )
  const reject = spyOn(SessionNetwork, "ask").mockImplementation(async () => ({
    id: QuestionID.ascending(),
    promise: Promise.reject(new SessionNetwork.RejectedError()),
  }))
  const telemetry: unknown[] = []
  const captureSpy = spyOn(Client, "capture").mockImplementation((event, properties) =>
    telemetry.push({ event, properties }),
  )
  const write = process.stdout.write
  const cwd = process.cwd()
  try {
    for (const item of scenarios) {
      current = item
      await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))
      const created = await sdk.session.create({ directory: tmp.path, title: `failure ${item.name}` })
      if (!created.data) throw new Error("HTTP session create failed")
      const assigned = await sdk.providerAccounts.session.assign({
        sessionID: created.data.id,
        providerID: "openai",
        accountID: a.id,
        directory: tmp.path,
      })
      expect(assigned.data?.providers.openai).toMatchObject({ mode: "profile", profileID: a.id })
      await AppRuntime.runPromise(profiles.selectDefault("openai", "chatgpt-oauth", b.id))
      if ("refresh" in item) {
        const credential = await AppRuntime.runPromise(profiles.credential(a.id))
        if (!credential) throw new Error("profile A credential missing")
        await AppRuntime.runPromise(
          profiles.compareAndSwapCredential({
            id: a.id,
            revision: credential.revision,
            value: { ...credential.value, expires: 0 },
          }),
        )
      }
      const prompt = await sdk.session.prompt({
        sessionID: created.data.id,
        directory: tmp.path,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5-mini" },
        parts: [{ type: "text", text: userText }],
      })
      expect(prompt.response?.status).toBe(200)
      const wire = await Promise.all([
        sdk.session.get({ sessionID: created.data.id, directory: tmp.path }),
        sdk.session.messages({ sessionID: created.data.id, directory: tmp.path }),
      ])
      const replay = await AppRuntime.runPromise(
        EventV2.Service.use((service) =>
          service.durable({ aggregateID: created.data!.id }).pipe(
            Stream.filter((event) => event.type === Session.Event.Updated.type),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      )
      const out = [] as string[]
      process.chdir(tmp.path)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        out.push(String(chunk))
        return true
      }) as typeof process.stdout.write
      const exportHandler = ExportCommand.handler
      if (!exportHandler) throw new Error("session export handler missing")
      await exportHandler({ sessionID: created.data.id, sanitize: true } as never)
      process.stdout.write = write
      process.chdir(cwd)
      const exported = out.join("")
      const messages = wire[1].data as
        | Array<{ info?: { role?: string; error?: unknown }; parts?: unknown[] }>
        | undefined
      const assistant = messages?.find((message) => message.info?.role === "assistant")
      const user = messages?.find((message) => message.info?.role === "user")
      const observed = JSON.stringify({ prompt, wire, events, replay: Array.from(replay), exported })
      expect(JSON.stringify(user?.parts)).toContain(userText)
      if ("reject" in item) {
        expect(observed).toContain(KiloSessionProcessor.PROFILE_OFFLINE_MESSAGE)
      } else {
        if (!assistant?.info?.error) throw new Error(`${item.name} did not persist an error`)
        expect(assistant.info.error).toMatchObject({
          data: { message: "The selected provider account request failed." },
        })
        expect(assistant.parts).toEqual([])
      }
      for (const marker of markers.filter((value) => value !== "SECRET_AUTH_CONTENT")) {
        expect(observed).not.toContain(marker)
      }
      expect(observed).toContain("SECRET_AUTH_CONTENT")
      expect(exported).not.toContain(userText)
      expect(exported).toContain("redacted:text")
      expect(JSON.stringify(telemetry)).not.toContain("SECRET_")
      if (!("refresh" in item)) {
        expect(calls.at(-1)?.bearer).toBe("Bearer SECRET_ACCESS_A")
        expect(calls.at(-1)?.account).toBe("failure-A")
      }
      expect(JSON.stringify(calls)).not.toContain("SECRET_ACCOUNT_B")
      expect(JSON.stringify(wire[0].data)).not.toContain("SECRET_ACCESS_A")
      expect(JSON.stringify(wire[1].data)).not.toContain("SECRET_REFRESH_A")
    }

    await Bun.write(`${tmp.path}/failure-matrix.txt`, "include one changed file")
    const providerFailure = new Error(`provider generation leaked ${raw}`, {
      cause: new Error(`transport cause ${raw}`),
    })
    const enhance = spyOn(EnhancePromptRuntime, "generate").mockRejectedValue(providerFailure)
    const commit = spyOn(CommitMessageRuntime, "generate").mockRejectedValue(providerFailure)
    try {
      const context = {
        kind: "account" as const,
        providerID: "openai" as const,
        authMode: "chatgpt-oauth" as const,
        accountID: a.id,
      }
      const prompt = await sdk.enhancePrompt.enhance({
        directory: tmp.path,
        text: userText,
        model: { providerID: "openai", modelID: "gpt-5-mini" },
        accountContext: context,
      })
      const message = await sdk.commitMessage.generate({
        directory: tmp.path,
        path: tmp.path,
        model: { providerID: "openai", modelID: "gpt-5-mini" },
        accountContext: context,
      })
      const publicErrors = JSON.stringify({ prompt, message })
      expect(publicErrors).toContain("The selected OpenAI account is unavailable")
      expect(publicErrors).toContain("Failed to generate commit message")
      for (const marker of markers) expect(publicErrors).not.toContain(marker)
      expect(enhance).toHaveBeenCalledTimes(1)
      expect(commit).toHaveBeenCalledTimes(1)
    } finally {
      enhance.mockRestore()
      commit.mockRestore()
    }
    const model = ProviderTest.model({
      id: ModelV2.ID.make("gpt-5-mini"),
      providerID: ProviderV2.ID.openai,
      api: { id: "gpt-5-mini", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
    })
    const credential = await AppRuntime.runPromise(profiles.credential(a.id))
    if (!credential) throw new Error("profile A credential missing")
    await AppRuntime.runPromise(
      profiles.compareAndSwapCredential({
        id: a.id,
        revision: credential.revision,
        value: { ...credential.value, expires: Date.now() + 60_000 },
      }),
    )
    const logs: string[] = []
    const log = console.log
    console.log = (value?: unknown) => logs.push(String(value))
    current = scenarios.find((item) => "status" in item && item.status === 401)!
    try {
      process.chdir(tmp.path)
      await rollCall({
        prompt: "Confirm model connectivity",
        timeout: 1_000,
        filter: "gpt-5-mini",
        parallel: 1,
        output: "json",
        verbose: false,
        quiet: true,
        legacyAuth: false,
        "legacy-auth": false,
        account: a.id,
        list: async () => ({ openai: { id: ProviderV2.ID.openai, name: "OpenAI", models: { "gpt-5-mini": model } } }),
      } as never)
    } finally {
      console.log = log
      process.chdir(cwd)
    }
    const output = logs.join("\n")
    expect(output).toContain('"access": false')
    expect(output).not.toContain("SECRET_")
    expect(refreshCalls.length).toBeGreaterThan(0)
    expect(refreshCalls.every((url) => url === "https://auth.openai.com/oauth/token")).toBe(true)
    expect(calls).toHaveLength(scenarios.length)
    current = scenarios.find((item) => "status" in item && item.status === 401)!
    const failed = await provideInstance({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          Agent.Service.use((service) =>
            service
              .generate({
                description: "Generate an agent under failed provider transport",
                model: { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5-mini") },
                utilityContext: {
                  kind: "account",
                  providerID: "openai",
                  authMode: "chatgpt-oauth",
                  accountID: a.id,
                },
              })
              .pipe(Effect.exit),
          ),
        ),
    })
    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") {
      const err = Cause.squash(failed.cause)
      expect(err).toBeInstanceOf(UtilityAccount.Failure)
      expect(JSON.stringify(err)).not.toContain("SECRET_")
    }
    expect(calls).toHaveLength(scenarios.length + 1)
    expect(calls.every((item) => item.bearer === "Bearer SECRET_ACCESS_A" && item.account === "failure-A")).toBe(true)
  } finally {
    process.stdout.write = write
    process.chdir(cwd)
    reject.mockRestore()
    await AppRuntime.runPromise(off)
    captureSpy.mockRestore()
    await server.stop(true)
    globalThis.fetch = prior.fetch
    if (prior.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.flag
    if (prior.key == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prior.key
    if (prior.auth == null) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = prior.auth
    await AppRuntime.runPromise(profiles.remove(a.id))
    await AppRuntime.runPromise(profiles.remove(b.id))
  }
}, 60_000)

test("real utility mapper and session sanitizer suppress failure chains", () => {
  for (const status of [401, 429, 503]) {
    const raw = new MessageV2.APIError({
      message: `upstream ${markers.join(" ")}`,
      statusCode: status,
      isRetryable: status !== 401,
      responseBody: JSON.stringify({ error: markers.join(" "), cause: { message: markers.join(" ") } }),
      responseHeaders: { authorization: markers[0]!, "set-cookie": markers[1]!, "retry-after": "1" },
    }).toObject()
    const safe = KiloSessionProcessor.profileError(raw)
    if (!MessageV2.APIError.isInstance(safe)) throw new Error("HTTP failure did not remain an API error")
    expect(safe.data.message).toBe("The selected provider account request failed.")
    expect(safe.data.statusCode).toBe(status)
    if (status === 401) expect(SessionRetry.retryable(safe)).toBeUndefined()
    else expect(SessionRetry.retryable(safe)).toEqual({ message: "The selected provider account request failed." })
    for (const marker of markers) expect(JSON.stringify(safe)).not.toContain(marker)
  }
  for (const item of failures) {
    const err = new Error(`provider failure ${markers.join(" ")}`, {
      cause: new Error(`nested parser/DNS/refresh detail ${markers.join(" ")}`),
    })
    const surfaced = UtilityAccount.message(err, "Failed to generate utility output")
    expect(surfaced).toBe("Failed to generate utility output")
    for (const marker of markers) expect(surfaced).not.toContain(marker)
    expect(item.name.length).toBeGreaterThan(0)
  }
})
