import { afterEach, beforeEach, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Provider } from "../../src/provider/provider"
import { Plugin } from "../../src/plugin"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const providerID = ProviderV2.ID.make("openai")
const modelID = ModelV2.ID.make("gpt-5-mini")
const model = {
  id: modelID,
  providerID,
  api: { id: modelID, npm: "@ai-sdk/openai", url: "" },
  options: {},
  headers: {},
  limit: { context: 128_000, output: 16_000 },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
} as unknown as Provider.Model
const language = {
  specificationVersion: "v3",
  provider: "openai",
  modelId: model.api.id,
  supportedUrls: {},
  doStream: async () => {
    throw new Error("synthetic stream failure")
  },
  doGenerate: async () => {
    throw new Error("synthetic generation failure")
  },
} as unknown as LanguageModelV3
const missingSeen: (string | undefined)[] = []
const missingAuth: string[] = []
const profileSeen: (string | undefined)[] = []
const profileAuth: string[] = []
const legacySeen: (string | undefined)[] = []
const legacyAuth: string[] = []
const missing = testEffect(setup(missingSeen, missingAuth))
const profile = testEffect(setup(profileSeen, profileAuth))
const legacy = testEffect(setup(legacySeen, legacyAuth))

function setup(seen: (string | undefined)[], auth: string[]) {
  return Layer.mergeAll(
    AppNodeBuilder.build(Agent.node, [
      [
        Provider.node,
        Layer.mock(Provider.Service)({
          getModel: () => Effect.succeed(model),
          getLanguage: (_model, profileID) => {
            seen.push(profileID)
            return Effect.succeed(language)
          },
        }),
      ],
      [
        Auth.node,
        Layer.mock(Auth.Service)({
          all: () => Effect.succeed({}),
          get: () =>
            Effect.sync(() => {
              auth.push("read")
              return undefined
            }),
        }),
      ],
      [Plugin.node, Layer.mock(Plugin.Service)({ trigger: (_name, _input, output) => Effect.succeed(output) })],
      [MCP.node, Layer.mock(MCP.Service)({})],
      [RuntimeFlags.node, RuntimeFlags.layer({})],
    ]),
    Layer.mock(ProviderAccountProfiles.Service)({
      get: (id) =>
        Effect.succeed({
          id,
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "synthetic",
          remoteID: null,
          timeCreated: 0,
          timeUpdated: 0,
        }),
      credential: () =>
        Effect.succeed({
          value: { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60_000 },
          revision: 0,
        }),
    }),
  )
}

beforeEach(() => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
})

afterEach(async () => {
  if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
  await disposeAllInstances()
  missingSeen.length = 0
  missingAuth.length = 0
  profileSeen.length = 0
  profileAuth.length = 0
  legacySeen.length = 0
  legacyAuth.length = 0
})

missing.instance("Agent.generate requires authority before language or legacy auth acquisition", () =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const exit = yield* agent
      .generate({ description: "synthetic agent", model: { providerID, modelID } })
      .pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    expect(missingSeen).toEqual([])
    expect(missingAuth).toEqual([])
  }),
)

profile.instance(
  "Agent.generate acquires the explicitly selected profile",
  () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const exit = yield* agent
        .generate({
          description: "synthetic agent",
          model: { providerID, modelID },
          utilityContext: {
            kind: "account",
            providerID: "openai",
            authMode: "chatgpt-oauth",
            accountID: "pacc_agent_test",
          },
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(profileSeen).toEqual(["pacc_agent_test"])
      expect(profileAuth).toEqual([])
    }) as unknown as Effect.Effect<void, unknown, never>,
)

legacy.instance("Agent.generate honors explicit legacy authority", () =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const exit = yield* agent
      .generate({
        description: "synthetic agent",
        model: { providerID, modelID },
        utilityContext: { kind: "legacy", providerID: "openai" },
      })
      .pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    expect(legacySeen).toEqual([undefined])
    expect(legacyAuth).toEqual(["read"])
  }),
)

legacy.instance("Agent.generate uses legacy authority when profiles are disabled", () =>
  Effect.gen(function* () {
    delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    const agent = yield* Agent.Service
    const exit = yield* agent
      .generate({ description: "synthetic agent", model: { providerID, modelID } })
      .pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    expect(legacySeen).toEqual([undefined])
    expect(legacyAuth).toEqual(["read"])
  }),
)
