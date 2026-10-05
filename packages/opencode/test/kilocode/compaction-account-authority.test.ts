import { describe, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Layer, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "../../src/provider/provider"
import { SessionCompaction } from "../../src/session/compaction"
import { Session } from "../../src/session/session"
import { SessionProcessor } from "../../src/session/processor"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { Config } from "../../src/config/config"
import { TestConfig } from "../fixture/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Schema } from "effect"
import { MessageID, PartID } from "../../src/session/schema"

const model = ProviderTest.model({
  id: ModelV2.ID.make("gpt-test"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-test", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
})

const language: LanguageModelV3 = {
  specificationVersion: "v3",
  provider: "openai",
  modelId: model.api.id,
  supportedUrls: {},
  doStream: async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        controller.enqueue({ type: "text-start", id: "summary" })
        controller.enqueue({ type: "text-delta", id: "summary", delta: "compacted summary" })
        controller.enqueue({ type: "text-end", id: "summary" })
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        })
        controller.close()
      },
    }),
    request: {},
  }),
} as unknown as LanguageModelV3

const snapshot = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: () => Effect.succeed(undefined),
    patch: (hash) => Effect.succeed({ hash, files: [] }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(""),
    diffFull: () => Effect.succeed([]),
    diffFile: () => Effect.succeed(undefined),
  }),
)

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
const cfg = Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(base) }))
const node = LayerNode.group([
  SessionCompaction.node,
  SessionProcessor.node,
  Session.node,
  ProviderAccountProfiles.node,
  Database.node,
  EventV2Bridge.node,
  SessionProjector.node,
  CrossSpawnSpawner.node,
])

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Session.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
  ),
)

const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES

describe("compaction account authority", () => {
  it.instance("uses the persisted source-session profile after the default changes", () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const acquired: Array<string | undefined> = []
    const provider = ProviderTest.fake({
      model,
      getLanguage: (_model, profileID) => {
        acquired.push(profileID)
        return Effect.succeed(language)
      },
    })
    return Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const sessions = yield* Session.Service
      const a = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Source A",
        remoteID: "remote-a",
        credential: { access: "access-a", refresh: "refresh-a", expires: Date.now() + 60_000 },
      })
      const b = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Default B",
        remoteID: "remote-b",
        credential: { access: "access-b", refresh: "refresh-b", expires: Date.now() + 60_000 },
      })
      yield* profiles.selectDefault("openai", "chatgpt-oauth", a.id)
      const source = yield* sessions.create({})
      expect((yield* sessions.binding(source.id))?.providers.openai).toMatchObject({
        mode: "profile",
        profileID: a.id,
      })
      yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)

      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: source.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.openai, modelID: model.id },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: source.id,
        type: "text",
        text: "summarize this conversation",
      })
      const compact = yield* SessionCompaction.Service
      yield* compact.create({
        sessionID: source.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.openai, modelID: model.id },
        auto: false,
      })
      const messages = yield* sessions.messages({ sessionID: source.id })
      const parent = messages.at(-1)?.info
      expect(parent?.role).toBe("user")
      if (parent?.role !== "user") return
      yield* compact.process({ parentID: parent.id, messages, sessionID: source.id, auto: false })

      expect(acquired).toEqual([a.id])
      expect(acquired).not.toContain(b.id)
      expect((yield* sessions.binding(source.id))?.providers.openai).toMatchObject({ profileID: a.id })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(node, [
          [Snapshot.node, snapshot],
          [SessionSummary.node, summary],
          [Config.node, cfg],
          [Provider.node, provider.layer],
        ]),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
        }),
      ),
    )
  })
})
