import { describe, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Stream, Effect, Layer, Result, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMClient } from "@opencode-ai/llm/route"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Agent } from "../../src/agent/agent"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const mdl = ProviderTest.model({
  id: ModelV2.ID.make("gpt-runtime-test"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-runtime-test", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
})
const other = ProviderTest.model({
  id: ModelV2.ID.make("other-runtime-test"),
  providerID: ProviderV2.ID.make("other"),
  api: { id: "other-runtime-test", npm: "@ai-sdk/openai", url: "https://api.example.com" },
})

let calls = 0
const requests: unknown[] = []
const language: LanguageModelV3 = {
  specificationVersion: "v3",
  provider: "openai",
  modelId: mdl.api.id,
  supportedUrls: {},
  doStream: async (...args: Parameters<LanguageModelV3["doStream"]>) => {
    calls++
    requests.push(args[0])
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "result" })
          controller.enqueue({ type: "text-delta", id: "result", delta: "result" })
          controller.enqueue({ type: "text-end", id: "result" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
      request: {},
    }
  },
} as unknown as LanguageModelV3

const base = Schema.decodeUnknownSync(ConfigV1.Info)({
  provider: {
    openai: {
      options: { apiKey: "API_POISON", baseURL: "https://api-poison.invalid" },
    },
  },
}) as ConfigV1.Info
const cfg = Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(base) }))
const auth = Layer.mock(Auth.Service, {
  get: (providerID: string) =>
    providerID === "openai"
      ? Effect.die(new Error("poisoned legacy OpenAI auth must not be consulted"))
      : Effect.succeed(undefined),
})
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die(new Error("native LLM client must not be used for profile authority")),
    stream: () => Stream.die(new Error("native LLM client must not be used for profile authority")),
    generate: () => Effect.die(new Error("native LLM client must not be used for profile authority")),
  }),
)

const node = LayerNode.group([
  Session.node,
  SessionProjector.node,
  ProviderAccountProfiles.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(AppNodeBuilder.build(node))
const prior = {
  profiles: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
  native: process.env.KILO_EXPERIMENTAL_NATIVE_LLM,
  api: process.env.OPENAI_API_KEY,
}

const binding = (profileID: string) =>
  SessionBinding.set(undefined, {
    version: 1,
    providers: { openai: { mode: "profile", profileID, authMode: "chatgpt-oauth", source: "explicit" } },
  })

const input = (args: {
  sessionID: string
  model?: Provider.Model
  context?: LLM.StreamInput["providerAccountContext"]
  name?: string
}) => {
  const model = args.model ?? mdl
  const sid = SessionID.make(args.sessionID)
  return {
    user: {
      id: MessageID.ascending(),
      sessionID: sid,
      role: "user",
      time: { created: Date.now() },
      agent: args.name ?? "title",
      model: { providerID: model.providerID, modelID: model.id },
    } satisfies SessionV1.User,
    sessionID: sid,
    model,
    agent: {
      name: args.name ?? "title",
      mode: "primary",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } satisfies Agent.Info,
    system: ["Return a short result."],
    messages: [{ role: "user", content: "generate a result" }],
    tools: {},
    providerAccountContext: args.context,
  } satisfies LLM.StreamInput
}

describe("utility runtime account authority", () => {
  it.instance("uses source and explicit account profiles with the AI SDK only", () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    process.env.KILO_EXPERIMENTAL_NATIVE_LLM = "true"
    process.env.OPENAI_API_KEY = "ENV_POISON"
    calls = 0
    requests.length = 0
    const seen: Array<string | undefined> = []
    const openai = ProviderTest.fake({
      model: mdl,
      getLanguage: (_model, profileID) => {
        seen.push(profileID)
        return Effect.succeed(language)
      },
    })
    const nonOpenai = ProviderTest.fake({
      model: other,
      getLanguage: (_model, profileID) => {
        seen.push(profileID)
        return Effect.succeed(language)
      },
    })

    const run = (value: LLM.StreamInput, provider: Layer.Layer<Provider.Service, never, never>) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const profiles = yield* ProviderAccountProfiles.Service
        const layer = AppNodeBuilder.build(LLM.node, [
          [Session.node, Layer.succeed(Session.Service, session)],
          [ProviderAccountProfiles.node, Layer.succeed(ProviderAccountProfiles.Service, profiles)],
          [Provider.node, provider],
          [Config.node, cfg],
          [Auth.node, auth],
          [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
          [LayerNodePlatform.llmClient, client],
        ])
        return yield* LLM.Service.use((svc) => svc.stream(value).pipe(Stream.runDrain)).pipe(Effect.provide(layer))
      })

    return Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const sessions = yield* Session.Service
      const unbound = yield* sessions.create({})
      expect((yield* sessions.binding(unbound.id))?.providers.openai).toEqual({
        mode: "unbound",
        reason: "profile-required",
      })
      const a = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Title source",
        remoteID: "runtime-a",
        credential: { access: "profile-a-access", refresh: "profile-a-refresh", expires: Date.now() + 60_000 },
      })
      const b = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Explicit commit",
        remoteID: "runtime-b",
        credential: { access: "profile-b-access", refresh: "profile-b-refresh", expires: Date.now() + 60_000 },
      })
      const source = yield* sessions.create({ metadata: binding(a.id) })
      expect((yield* sessions.binding(source.id))?.providers.openai).toMatchObject({ profileID: a.id })

      yield* run(
        input({
          sessionID: "ses_synthetic-request-id",
          context: { kind: "session", sourceSessionID: source.id },
        }),
        openai.layer,
      )
      yield* run(input({ sessionID: source.id }), openai.layer)
      yield* run(
        input({
          sessionID: "ses_synthetic-commit-request-id",
          name: "commit-message",
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
        }),
        openai.layer,
      )
      expect(seen).toEqual([a.id, a.id, b.id])
      expect(calls).toBe(3)

      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
      const disabled = yield* Effect.result(
        run(
          input({
            sessionID: "ses_disabled-account-request-id",
            context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: a.id },
          }),
          openai.layer,
        ),
      )
      expect(Result.isFailure(disabled)).toBe(true)
      if (Result.isFailure(disabled)) expect(String(disabled.failure)).toContain("profiles are disabled")

      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      const sourceError = yield* Effect.result(
        run(
          input({
            sessionID: "ses_unbound-source-request-id",
            context: { kind: "session", sourceSessionID: unbound.id },
          }),
          openai.layer,
        ),
      )
      expect(Result.isFailure(sourceError)).toBe(true)
      if (Result.isFailure(sourceError))
        expect(String(sourceError.failure)).toContain("source session requires an OpenAI account binding")

      yield* run(
        input({
          sessionID: "ses_non-openai-request-id",
          model: other,
          context: { kind: "session", sourceSessionID: source.id },
        }),
        nonOpenai.layer,
      )
      expect(seen).toEqual([a.id, a.id, b.id, undefined])
      expect(calls).toBe(4)
      expect(JSON.stringify(requests)).not.toContain("POISON")
    }).pipe(
      Effect.provide(AppNodeBuilder.build(node)),
      Effect.ensuring(
        Effect.sync(() => {
          if (prior.profiles === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.profiles
          if (prior.native === undefined) delete process.env.KILO_EXPERIMENTAL_NATIVE_LLM
          else process.env.KILO_EXPERIMENTAL_NATIVE_LLM = prior.native
          if (prior.api === undefined) delete process.env.OPENAI_API_KEY
          else process.env.OPENAI_API_KEY = prior.api
        }),
      ),
    )
  })
})
