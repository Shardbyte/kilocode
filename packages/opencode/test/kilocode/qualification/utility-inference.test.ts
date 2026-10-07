import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMClient } from "@opencode-ai/llm/route"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ProjectV2 } from "@opencode-ai/core/project"
import { CommitMessageRuntime, generateCommitMessage, prepareCommitMessage } from "@/kilocode/commit-message/generate"
import { Effect, Layer, Schema, Stream } from "effect"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { CommitMessagePayload, EnhancePromptPayload } from "@/kilocode/utility-generation-schema"
import { Config } from "@/config/config"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"
import { generateText } from "ai"
import { TestInstance } from "../../fixture/fixture"

const model = { providerID: ProviderV2.ID.openai, id: ModelV2.ID.make("gpt-5") }
const modelID = model
const hook = { calls: 0 }

const config = (options: Record<string, unknown> = {}) => ({
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      options,
      models: { "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } } },
    },
    anthropic: {
      npm: "@ai-sdk/anthropic",
      options: { apiKey: "SYNTHETIC_ANTHROPIC_KEY" },
      models: { "claude-test": { name: "Claude Test", limit: { context: 128000, output: 4096 } } },
    },
  },
})

function providerLayer(cfg: ReturnType<typeof config>) {
  return AppNodeBuilder.build(
    LayerNode.group([Provider.node, ProviderAccountProfiles.node, Config.node, ModelsDev.node]),
    [
      [Config.node, TestConfig.layer({ get: () => Effect.succeed(cfg) })],
      [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
    ],
  )
}

test("standalone generation DTOs reject authority smuggling and extra credential fields", () => {
  const commit = (value: unknown) => Schema.decodeUnknownSync(CommitMessagePayload)(value)
  const enhance = (value: unknown) => Schema.decodeUnknownSync(EnhancePromptPayload)(value)
  const base = {
    path: "/tmp/repo",
    accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "acct" },
  } as const
  expect(commit(base).accountContext).toEqual(base.accountContext)
  for (const attack of [
    { ...base, apiKey: "POISON" },
    { ...base, headers: { authorization: "Bearer POISON" } },
    { ...base, accountContext: { ...base.accountContext, accessToken: "POISON" } },
    { ...base, accountContext: { kind: "session", sourceSessionID: "ses_synthetic" } },
  ])
    expect(() => commit(attack)).toThrow()
  expect(enhance({ text: "draft", accountContext: { kind: "session", sourceSessionID: "ses_source" } }).text).toBe(
    "draft",
  )
  expect(() =>
    enhance({
      text: "draft",
      accountContext: {
        kind: "account",
        providerID: "openai",
        authMode: "chatgpt-oauth",
        accountID: "acct",
        refresh: "POISON",
      },
    }),
  ).toThrow()
})

testEffect(providerLayer(config())).instance(
  "real prepare/generate boundary rejects a model removed after preparation without generation fallback",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        return prior
      }),
      () =>
        Effect.promise(async () => {
          const refs: Array<{ providerID: string; modelID: string } | undefined> = []
          const actual = CommitMessageRuntime.model.bind(CommitMessageRuntime)
          const select = spyOn(CommitMessageRuntime, "model").mockImplementation(async (ref) => {
            refs.push(ref)
            if (ref) throw new Error("prepared model was removed")
            return actual()
          })
          const generate = spyOn(CommitMessageRuntime, "generate").mockResolvedValue("unexpected fallback")
          try {
            const prepared = await prepareCommitMessage()
            const result = await generateCommitMessage({
              path: "/tmp/utility-model-was-removed",
              model: prepared.model,
              accountContext: { kind: "legacy", providerID: prepared.model.providerID },
            }).then(
              (value) => value,
              (err: unknown) => err,
            )
            expect(result).toMatchObject({ name: "UtilityAccountError", code: "model-unavailable" })
            expect(result).toBeInstanceOf(Error)
            if (!(result instanceof Error)) throw new Error("stale prepared model unexpectedly generated a response")
            expect(result.message).toBe("The selected utility model is unavailable; prepare this generation again")
            expect(refs).toEqual([undefined, prepared.model])
            expect(generate).not.toHaveBeenCalled()
          } finally {
            select.mockRestore()
            generate.mockRestore()
          }
        }),
      (prior) =>
        Effect.sync(() => {
          if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
        }),
    ),
)

testEffect(
  providerLayer(
    config({
      headers: { "x-safe-marker": "ok" },
      fetch: async () => {
        hook.calls++
        throw new Error("configured fetch hook must not receive profile requests")
      },
    }),
  ),
).instance(
  "real Provider.getLanguage binds SDK transport to selected profile despite poisoned ambient credentials",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          key: process.env.OPENAI_API_KEY,
          auth: process.env.KILO_AUTH_CONTENT,
          fetch: globalThis.fetch,
        }
        const calls: Array<{ url: string; headers: Headers }> = []
        hook.calls = 0
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "STORED_LEGACY_POISON" } })
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
              url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
              headers: new Headers(init?.headers),
            })
            return Response.json({ error: { message: "synthetic rejected request" } }, { status: 401 })
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls }
      }),
      (state) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const account = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "synthetic",
            remoteID: "remote-synthetic",
            credential: {
              access: "PROFILE_ACCESS_MARKER",
              refresh: "PROFILE_REFRESH_MARKER",
              expires: Date.now() + 60_000,
              accountID: "remote-synthetic",
            },
          })
          const provider = yield* Provider.Service
          const item = yield* provider.getModel(model.providerID, model.id)
          const language = yield* provider.getLanguage(item, account.id)
          yield* Effect.tryPromise(() =>
            language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] }),
          ).pipe(Effect.flip)
          expect(state.calls).toHaveLength(1)
          expect(state.calls.at(0)?.url).toStartWith("https://chatgpt.com/backend-api/codex/responses")
          expect(state.calls.at(0)?.headers.get("authorization")).toBe("Bearer PROFILE_ACCESS_MARKER")
          expect(state.calls.at(0)?.headers.get("chatgpt-account-id")).toBe("remote-synthetic")
          expect(JSON.stringify(state.calls)).not.toContain("POISON")
          expect(JSON.stringify(state.calls)).not.toContain("PROFILE_REFRESH_MARKER")
          expect(hook.calls).toBe(0)
        }),
      (state) =>
        Effect.sync(() => {
          globalThis.fetch = state.fetch
          if (state.flag === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
          if (state.key === undefined) delete process.env.OPENAI_API_KEY
          else process.env.OPENAI_API_KEY = state.key
          if (state.auth === undefined) delete process.env.KILO_AUTH_CONTENT
          else process.env.KILO_AUTH_CONTENT = state.auth
        }),
    ),
)

testEffect(providerLayer(config({ maxRetries: 0 }))).instance(
  "separate failed SDK calls retain their captured profile A through quota, authorization, and network failures",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          key: process.env.OPENAI_API_KEY,
          auth: process.env.KILO_AUTH_CONTENT,
          fetch: globalThis.fetch,
        }
        const calls: Array<{ bearer: string | null; account: string | null; url: string }> = []
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "STORED_LEGACY_POISON" } })
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const ix = calls.push({
              bearer: new Headers(init?.headers).get("authorization"),
              account: new Headers(init?.headers).get("chatgpt-account-id"),
              url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            })
            if (ix === 1) return Response.json({ error: { message: "synthetic quota" } }, { status: 429 })
            if (ix === 2) return Response.json({ error: { message: "synthetic unauthorized" } }, { status: 401 })
            throw new Error("synthetic network failure")
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls }
      }),
      (state) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const a = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "A",
            remoteID: "remote-A",
            credential: {
              access: "PROFILE_A_ACCESS",
              refresh: "PROFILE_A_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "remote-A",
            },
          })
          const b = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "B",
            remoteID: "remote-B",
            credential: {
              access: "PROFILE_B_ACCESS",
              refresh: "PROFILE_B_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "remote-B",
            },
          })
          yield* profiles.selectDefault("openai", "chatgpt-oauth", a.id)
          const provider = yield* Provider.Service
          const item = yield* provider.getModel(model.providerID, model.id)
          const language = yield* provider.getLanguage(item, a.id)
          yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
          const input = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "synthetic" }] }] }
          for (let ix = 0; ix < 3; ix++) {
            const failed = yield* Effect.exit(Effect.tryPromise(() => language.doGenerate(input)))
            expect(failed._tag).toBe("Failure")
          }
          expect(state.calls).toHaveLength(3)
          expect(state.calls.map((call) => call.bearer)).toEqual([
            "Bearer PROFILE_A_ACCESS",
            "Bearer PROFILE_A_ACCESS",
            "Bearer PROFILE_A_ACCESS",
          ])
          expect(state.calls.map((call) => call.account)).toEqual(["remote-A", "remote-A", "remote-A"])
          expect(JSON.stringify(state.calls)).not.toContain("PROFILE_B")
          expect(JSON.stringify(state.calls)).not.toContain("POISON")

          yield* profiles.remove(a.id)
          const retry = yield* Effect.exit(Effect.tryPromise(() => language.doGenerate(input)))
          expect(retry._tag).toBe("Failure")
          expect(state.calls).toHaveLength(3)
        }),
      (state) =>
        Effect.sync(() => {
          globalThis.fetch = state.fetch
          if (state.flag === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
          if (state.key === undefined) delete process.env.OPENAI_API_KEY
          else process.env.OPENAI_API_KEY = state.key
          if (state.auth === undefined) delete process.env.KILO_AUTH_CONTENT
          else process.env.KILO_AUTH_CONTENT = state.auth
        }),
    ),
)

testEffect(providerLayer(config())).instance(
  "real SDK model cache separates A and B and uses OAuth refresh across account deletion",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          key: process.env.OPENAI_API_KEY,
          auth: process.env.KILO_AUTH_CONTENT,
          fetch: globalThis.fetch,
        }
        const calls: Array<{ bearer: string | null; account: string | null }> = []
        const refreshes: string[] = []
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "LEGACY_POISON" } })
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
            if (url === "https://auth.openai.com/oauth/token") {
              refreshes.push(url)
              const payload = btoa(JSON.stringify({ chatgpt_account_id: "remote-A" }))
              return Response.json({
                access_token: "CACHE_A_ACCESS_V2",
                refresh_token: "CACHE_A_REFRESH_V2",
                id_token: `header.${payload}.signature`,
                expires_in: 3600,
              })
            }
            calls.push({
              bearer: new Headers(init?.headers).get("authorization"),
              account: new Headers(init?.headers).get("chatgpt-account-id"),
            })
            return Response.json({ error: { message: "synthetic rejected request" } }, { status: 401 })
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls, refreshes }
      }),
      (state) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const a = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "A",
            remoteID: "remote-A",
            credential: {
              access: "CACHE_A_ACCESS_V1",
              refresh: "CACHE_A_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "remote-A",
            },
          })
          const b = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "B",
            remoteID: "remote-B",
            credential: {
              access: "CACHE_B_ACCESS",
              refresh: "CACHE_B_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "remote-B",
            },
          })
          const provider = yield* Provider.Service
          const item = yield* provider.getModel(model.providerID, model.id)
          const la = yield* provider.getLanguage(item, a.id)
          const lb = yield* provider.getLanguage(item, b.id)
          expect(yield* provider.getLanguage(item, a.id)).toBe(la)
          expect(lb).not.toBe(la)
          const ia = yield* UtilityAccount.standalone({
            operation: "commit-message",
            model: item,
            context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: a.id },
          })
          const ib = yield* UtilityAccount.standalone({
            operation: "commit-message",
            model: item,
            context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
          })
          expect(ia.mode).toBe("profile")
          expect(ib.mode).toBe("profile")
          if (ia.mode !== "profile" || ib.mode !== "profile")
            throw new Error("account identity did not resolve to profiles")
          expect(ia.id).not.toBe(ib.id)
          expect(ia.profileID).toBe(a.id)
          expect(ib.profileID).toBe(b.id)
          expect(ia.modelID).toBe(ib.modelID)
          expect(JSON.stringify([ia, ib])).not.toContain("ACCESS")
          expect(JSON.stringify([ia, ib])).not.toContain("REFRESH")

          const input = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "cache" }] }] }
          for (const lang of [la, lb, la]) yield* Effect.exit(Effect.tryPromise(() => lang.doGenerate(input)))
          expect(state.calls.map((call) => call.bearer)).toEqual([
            "Bearer CACHE_A_ACCESS_V1",
            "Bearer CACHE_B_ACCESS",
            "Bearer CACHE_A_ACCESS_V1",
          ])
          expect(state.calls.map((call) => call.account)).toEqual(["remote-A", "remote-B", "remote-A"])

          const cred = yield* profiles.credential(a.id)
          if (!cred) throw new Error("profile A credential unexpectedly missing")
          yield* profiles.compareAndSwapCredential({
            id: a.id,
            revision: cred.revision,
            value: { ...cred.value, expires: Date.now() - 1 },
          })
          const refreshed = yield* provider.getLanguage(item, a.id)
          expect(refreshed).toBe(la)
          yield* Effect.exit(Effect.tryPromise(() => refreshed.doGenerate(input)))
          expect(state.refreshes).toEqual(["https://auth.openai.com/oauth/token"])
          expect(state.calls.at(-1)?.bearer).toBe("Bearer CACHE_A_ACCESS_V2")
          expect(state.calls.at(-1)?.account).toBe("remote-A")

          yield* Effect.exit(Effect.tryPromise(() => lb.doGenerate(input)))
          expect(state.calls.at(-1)?.bearer).toBe("Bearer CACHE_B_ACCESS")
          yield* profiles.remove(a.id)
          const before = state.calls.length
          const failed = yield* Effect.exit(Effect.tryPromise(() => la.doGenerate(input)))
          expect(failed._tag).toBe("Failure")
          expect(state.calls).toHaveLength(before)
          const remaining = yield* provider.getLanguage(item, b.id)
          expect(remaining).toBe(lb)
          yield* Effect.exit(Effect.tryPromise(() => remaining.doGenerate(input)))
          expect(state.calls.at(-1)?.bearer).toBe("Bearer CACHE_B_ACCESS")
          expect(state.calls.at(-1)?.account).toBe("remote-B")
          expect(JSON.stringify(state.calls)).not.toContain("POISON")
          expect(JSON.stringify(state.calls)).not.toContain("REFRESH")
        }),
      (state) =>
        Effect.sync(() => {
          globalThis.fetch = state.fetch
          if (state.flag === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
          if (state.key === undefined) delete process.env.OPENAI_API_KEY
          else process.env.OPENAI_API_KEY = state.key
          if (state.auth === undefined) delete process.env.KILO_AUTH_CONTENT
          else process.env.KILO_AUTH_CONTENT = state.auth
        }),
    ),
)

testEffect(providerLayer(config())).instance(
  "an automatic SDK retry keeps profile A after default, environment, and legacy credentials change",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          key: process.env.OPENAI_API_KEY,
          auth: process.env.KILO_AUTH_CONTENT,
          fetch: globalThis.fetch,
        }
        const calls: Array<{ bearer: string | null; account: string | null }> = []
        const start = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<void>()
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "LEGACY_POISON" } })
        globalThis.fetch = Object.assign(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
            const ix = calls.push({
              bearer: new Headers(init?.headers).get("authorization"),
              account: new Headers(init?.headers).get("chatgpt-account-id"),
            })
            if (ix === 1) {
              start.resolve()
              await gate.promise
              return Response.json({ error: { message: "synthetic retryable failure" } }, { status: 429 })
            }
            return Response.json({ error: { message: "synthetic rejected request" } }, { status: 401 })
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls, start: start.promise, gate }
      }),
      (state) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const a = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "A",
            remoteID: "retry-A",
            credential: {
              access: "RETRY_A_ACCESS",
              refresh: "RETRY_A_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "retry-A",
            },
          })
          const b = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "B",
            remoteID: "retry-B",
            credential: {
              access: "RETRY_B_ACCESS",
              refresh: "RETRY_B_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "retry-B",
            },
          })
          yield* profiles.selectDefault("openai", "chatgpt-oauth", a.id)
          const provider = yield* Provider.Service
          const item = yield* provider.getModel(model.providerID, model.id)
          const language = yield* provider.getLanguage(item, a.id)
          const pending = generateText({ model: language, prompt: "retry", maxRetries: 2 }).then(
            () => undefined,
            () => undefined,
          )
          yield* Effect.promise(() => state.start)
          yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
          process.env.OPENAI_API_KEY = "CHANGED_ENV_POISON"
          process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "CHANGED_LEGACY_POISON" } })
          state.gate.resolve()
          yield* Effect.promise(() => pending)
          expect(state.calls.length).toBeGreaterThanOrEqual(2)
          expect(state.calls.map((call) => call.bearer)).toEqual(state.calls.map(() => "Bearer RETRY_A_ACCESS"))
          expect(state.calls.map((call) => call.account)).toEqual(state.calls.map(() => "retry-A"))
          expect(JSON.stringify(state.calls)).not.toContain("POISON")
        }),
      (state) =>
        Effect.sync(() => {
          state.gate.resolve()
          globalThis.fetch = state.fetch
          if (state.flag === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
          if (state.key === undefined) delete process.env.OPENAI_API_KEY
          else process.env.OPENAI_API_KEY = state.key
          if (state.auth === undefined) delete process.env.KILO_AUTH_CONTENT
          else process.env.KILO_AUTH_CONTENT = state.auth
        }),
    ),
)

testEffect(providerLayer(config())).instance(
  "real Provider model incompatible with account context fails before transport",
  () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const acct = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "OpenAI account",
        credential: { access: "PROFILE_ACCESS", refresh: "PROFILE_REFRESH", expires: Date.now() + 60_000 },
      })
      const provider = yield* Provider.Service
      const incompatible = yield* provider.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make("claude-test"))
      const denied = yield* Effect.exit(
        UtilityAccount.standalone({
          operation: "commit-message",
          model: incompatible,
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
        }),
      )
      expect(denied._tag).toBe("Failure")
      if (denied._tag === "Failure") expect(String(denied.cause)).toContain("context does not match")
    }),
)

for (const [cfg, reason] of [
  [config({ apiKey: "CONFIG_POISON" }), "apiKey"],
  [config({ baseURL: "https://attacker.invalid/v1" }), "baseURL"],
  [config({ headers: { Authorization: "Bearer CONFIG_POISON" } }), "authorization header"],
] as const)
  testEffect(providerLayer(cfg)).instance(`real Provider.getLanguage rejects profile ${reason} override`, () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        return prior
      }),
      (_prior) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const account = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "synthetic",
            credential: { access: "PROFILE_ACCESS", refresh: "PROFILE_REFRESH", expires: Date.now() + 60_000 },
          })
          const provider = yield* Provider.Service
          const item = yield* provider.getModel(model.providerID, model.id)
          const result = yield* Effect.exit(provider.getLanguage(item, account.id))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(String(result.cause)).toContain("cannot be combined")
        }),
      (prior) =>
        Effect.sync(() => {
          if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
        }),
    ),
  )

const utility = testEffect(LayerNode.compile(ProviderAccountProfiles.node))
const dispatchCalls: string[] = []
const dispatchStub = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die(new Error("synthetic native prepare unused")),
    stream: (request) => {
      dispatchCalls.push(request.model.id)
      return Stream.empty
    },
    generate: () => Effect.die(new Error("synthetic native generate unused")),
  }),
)
const sessionGraph = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      LLM.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      ProviderAccountProfiles.node,
      SessionBinding.node,
      Provider.node,
      Config.node,
      ModelsDev.node,
    ]),
    [
      [Config.node, TestConfig.layer({ get: () => Effect.succeed({ ...config(), small_model: "openai/gpt-5" }) })],
      [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
      [LayerNodePlatform.llmClient, dispatchStub],
    ],
  ),
)

sessionGraph.instance(
  "commit-message utility generation failure logs the actual sanitized error line",
  () =>
    Effect.gen(function* () {
      if (process.env.KILO_QUALIFICATION_LOG_CHILD !== "1") {
        // The logger has no reversible sink API. Keep transport selection in a child,
        // so earlier file-mode initialization and later tests retain their own state.
        yield* Effect.promise(async () => {
          const child = Bun.spawn(
            [
              process.execPath,
              "test",
              "test/kilocode/qualification/utility-inference.test.ts",
              "--test-name-pattern",
              "^commit-message utility generation failure logs the actual sanitized error line$",
            ],
            {
              cwd: path.resolve(import.meta.dir, "../../.."),
              env: { ...process.env, KILO_QUALIFICATION_LOG_CHILD: "1" },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              windowsHide: true,
              signal: AbortSignal.timeout(120_000),
            },
          )
          const [out, err, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          expect(code).toBe(0)
          expect(out + err).toMatch(/^\s*1 pass\s*$/m)
          expect(out + err).toMatch(/^\s*0 fail\s*$/m)
          for (const marker of [
            "SECRET_ACCESS_A",
            "SECRET_REFRESH_A",
            "SECRET_PROVIDER_ERROR",
            "SECRET_ENV_KEY",
            "SECRET_AUTH_CONTENT",
          ])
            expect(out + err).not.toContain(marker)
        })
        return
      }
      yield* Effect.promise(() => import("@opencode-ai/core/util/log").then(({ Log }) => Log.init({ print: true })))
      const dir = yield* TestInstance
      const provider = yield* Provider.Service
      const item = yield* provider.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5"))
      yield* Effect.promise(async () => {
        const markers = [
          "SECRET_ACCESS_A",
          "SECRET_REFRESH_A",
          "SECRET_PROVIDER_ERROR",
          "SECRET_ENV_KEY",
          "SECRET_AUTH_CONTENT",
        ]
        const output: string[] = []
        const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
          output.push(String(chunk))
          return true
        })
        const generate = spyOn(CommitMessageRuntime, "generate").mockRejectedValue(new Error(markers.join(" ")))
        const select = spyOn(CommitMessageRuntime, "model").mockResolvedValue(item)
        const resolve = spyOn(CommitMessageRuntime, "resolve").mockResolvedValue({
          id: "synthetic-utility-identity",
          operation: "commit-message",
          directory: dir.directory,
          providerID: item.providerID,
          modelID: item.id,
          mode: "legacy",
        })
        try {
          const prepared = await prepareCommitMessage()
          expect(prepared.model).toEqual({ providerID: item.providerID, modelID: item.id })
          const result = await generateCommitMessage({
            path: dir.directory,
            model: prepared.model,
            accountContext: { kind: "legacy", providerID: prepared.model.providerID },
          }).then(
            (value) => value,
            (err: unknown) => err,
          )
          expect(result).toBeInstanceOf(Error)
          if (!(result instanceof Error)) throw new Error("synthetic generation failure unexpectedly succeeded")
          expect(result.message).toBe("Failed to generate commit message")
          expect(generate).toHaveBeenCalledTimes(1)
          const captured = output.join("")
          expect(captured).toContain("service=commit-message")
          expect(captured).toContain("generation failed")
          for (const marker of markers) {
            expect(captured).not.toContain(marker)
            expect(result.message).not.toContain(marker)
          }
        } finally {
          write.mockRestore()
          generate.mockRestore()
          select.mockRestore()
          resolve.mockRestore()
        }
      })
    }),
  {
    git: true,
    init: (dir) => Effect.promise(() => Bun.write(`${dir}/change.ts`, "export const change = true\n")),
  },
  130_000,
)

sessionGraph.instance("LLM dispatch stub admits explicit legacy control but never dispatches a resolved profile", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = {
        profiles: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
        key: process.env.OPENAI_API_KEY,
        fetch: globalThis.fetch,
      }
      const wire: Array<{ url: string; headers: Headers }> = []
      dispatchCalls.length = 0
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "SYNTHETIC_LEGACY_KEY"
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          wire.push({
            url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            headers: new Headers(init?.headers),
          })
          return Response.json({ error: { message: "synthetic unauthorized" } }, { status: 401 })
        },
        { preconnect: prior.fetch.preconnect },
      )
      return { ...prior, wire, dispatched: dispatchCalls }
    }),
    (state) =>
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(modelID.providerID, modelID.id)
        const run = (context: LLM.StreamInput["providerAccountContext"]) => {
          const sid = SessionID.make("ses_native_qualification")
          const agent = {
            name: "qualification",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const input = {
            user: {
              id: MessageID.ascending(),
              sessionID: sid,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: model.providerID, modelID: model.id },
            } satisfies SessionV1.User,
            sessionID: sid,
            model,
            agent,
            system: ["Return a short synthetic result."],
            messages: [{ role: "user" as const, content: "qualification" }],
            tools: {},
            providerAccountContext: context,
          } satisfies LLM.StreamInput
          return LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain))
        }

        const legacy = yield* Effect.exit(run({ kind: "legacy", providerID: "openai" }))
        expect(legacy._tag).toBe("Success")
        expect(state.dispatched).toHaveLength(1)
        expect(state.wire).toHaveLength(0)

        const acct = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "profile A",
          remoteID: "native-profile-a",
          credential: {
            access: "NATIVE_PROFILE_A_ACCESS",
            refresh: "NATIVE_PROFILE_A_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "native-profile-a",
          },
        })
        const profiled = yield* Effect.exit(
          run({ kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id }),
        )
        expect(profiled._tag).toBe("Failure")
        expect(state.dispatched).toHaveLength(1)
        expect(state.wire).toHaveLength(1)
        expect(state.wire.at(0)?.url).toStartWith("https://chatgpt.com/backend-api/codex/responses")
        expect(state.wire.at(0)?.headers.get("authorization")).toBe("Bearer NATIVE_PROFILE_A_ACCESS")
        expect(state.wire.at(0)?.headers.get("chatgpt-account-id")).toBe("native-profile-a")
      }),
    (state) =>
      Effect.sync(() => {
        globalThis.fetch = state.fetch
        if (state.profiles === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.profiles
        if (state.key === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = state.key
      }),
  ),
)
utility.instance("resolver identity ignores defaults and cannot mutate into another model", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      return prior
    }),
    (_prior) =>
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const acct = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "synthetic",
          credential: { access: "ACCESS", refresh: "REFRESH", expires: Date.now() + 60_000 },
        })
        yield* profiles.selectDefault("openai", "chatgpt-oauth", acct.id)
        const denied = yield* Effect.exit(UtilityAccount.standalone({ operation: "commit-message", model }))
        expect(denied._tag).toBe("Failure")
        const chosen = { ...model }
        const identity = yield* UtilityAccount.standalone({
          operation: "commit-message",
          model: chosen,
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
        })
        chosen.id = ModelV2.ID.make("attacker-selected-model")
        expect(Object.isFrozen(identity)).toBe(true)
        expect(Reflect.set(identity, "modelID", "attacker-selected-model")).toBe(false)
        expect(identity.modelID).toBe(model.id)
        expect(identity.providerID).toBe(model.providerID)
        expect(JSON.stringify(identity)).not.toContain("ACCESS")
        expect(JSON.stringify(identity)).not.toContain("REFRESH")
      }),
    (prior) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
      }),
  ),
)

sessionGraph.instance(
  "real source resolver rejects wrong routed directory, project, deleted, and synthetic source ids",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        return prior
      }),
      (_prior) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const acct = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "source",
            credential: { access: "SOURCE_ACCESS", refresh: "SOURCE_REFRESH", expires: Date.now() + 60_000 },
          })
          yield* profiles.selectDefault("openai", "chatgpt-oauth", acct.id)
          const sessions = yield* Session.Service
          const source = yield* sessions.create()
          const ref = yield* InstanceRef
          if (!ref) throw new Error("test instance context was unavailable")
          const request = {
            operation: "title" as const,
            model,
            context: { kind: "session" as const, sourceSessionID: source.id },
          }
          const identity = yield* UtilityAccount.resolve(request)
          expect(identity.mode).toBe("profile")
          if (identity.mode !== "profile") throw new Error("source resolver did not return profile authority")
          expect(identity.profileID).toBe(acct.id)
          for (const routed of [
            { ...ref, directory: `${ref.directory}-other` },
            { ...ref, project: { ...ref.project, id: ProjectV2.ID.make(`${ref.project.id}-other`) } },
          ]) {
            const foreign = yield* sessions.create().pipe(Effect.provideService(InstanceRef, routed))
            expect(foreign.directory).toBe(routed.directory)
            const denied = yield* Effect.exit(
              UtilityAccount.resolve({
                ...request,
                context: { ...request.context, sourceSessionID: foreign.id },
              }),
            )
            expect(denied._tag).toBe("Failure")
            if (denied._tag === "Failure") expect(String(denied.cause)).toContain("source session is unavailable")
          }
          const synthetic = yield* Effect.exit(
            UtilityAccount.resolve({ ...request, context: { ...request.context, sourceSessionID: "ses_synthetic" } }),
          )
          expect(synthetic._tag).toBe("Failure")
          if (synthetic._tag === "Failure") expect(String(synthetic.cause)).toContain("source session is unavailable")
          const nonexistent = yield* Effect.exit(
            UtilityAccount.resolve({
              ...request,
              context: { ...request.context, sourceSessionID: "ses_never_created" },
            }),
          )
          expect(nonexistent._tag).toBe("Failure")
          if (nonexistent._tag === "Failure")
            expect(String(nonexistent.cause)).toContain("source session is unavailable")
          yield* sessions.remove(source.id)
          const deleted = yield* Effect.exit(UtilityAccount.resolve(request))
          expect(deleted._tag).toBe("Failure")
          if (deleted._tag === "Failure") expect(String(deleted.cause)).toContain("source session is unavailable")
        }),
      (prior) =>
        Effect.sync(() => {
          if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
        }),
    ),
)
