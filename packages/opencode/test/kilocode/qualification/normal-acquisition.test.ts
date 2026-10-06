import { expect, spyOn } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLM } from "@/session/llm"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"
import { TestInstance } from "../../fixture/fixture"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"

const model = { providerID: ProviderV2.ID.openai, id: ModelV2.ID.make("gpt-5") }
const hook = { ambient: 0 }
const config = {
  small_model: "openai/gpt-5",
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      options: {
        fetch: async () => {
          hook.ambient++
          throw new Error("ambient configured fetch must not receive profile requests")
        },
      },
      models: {
        "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } },
        "gpt-5-mini": { name: "GPT-5 Mini", limit: { context: 128000, output: 4096 } },
      },
    },
  },
}

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      LLM.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      EventV2Bridge.node,
      ProviderAccountProfiles.node,
      SessionBinding.node,
      Provider.node,
      Config.node,
      ModelsDev.node,
    ]),
    [
      [Config.node, TestConfig.layer({ get: () => Effect.succeed(config) })],
      [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
    ],
  ),
)

it.instance("normal LLM fails closed when its selected account is deleted after real language acquisition", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = {
        flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
        key: process.env.OPENAI_API_KEY,
        auth: process.env.KILO_AUTH_CONTENT,
        fetch: globalThis.fetch,
      }
      const calls: Array<{ url: string; bearer: string | null }> = []
      hook.ambient = 0
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "NORMAL_ACQUISITION_ENV_POISON"
      process.env.KILO_AUTH_CONTENT = JSON.stringify({
        openai: { type: "api", key: "NORMAL_ACQUISITION_LEGACY_POISON" },
      })
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            bearer: new Headers(init?.headers).get("authorization"),
          })
          return Response.json({ error: { message: "unexpected transport" } }, { status: 401 })
        },
        { preconnect: prior.fetch.preconnect },
      )
      return { ...prior, calls }
    }),
    (state) =>
      Effect.gen(function* () {
        const dir = yield* TestInstance
        const profiles = yield* ProviderAccountProfiles.Service
        const sessions = yield* Session.Service
        const provider = yield* Provider.Service
        const account = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "normal acquisition A",
          remoteID: "normal-acquisition-A",
          credential: {
            access: "NORMAL_ACQUISITION_A_ACCESS",
            refresh: "NORMAL_ACQUISITION_A_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "normal-acquisition-A",
          },
        })
        yield* Effect.addFinalizer(() => profiles.remove(account.id).pipe(Effect.orDie))
        yield* profiles.clearDefault("openai", "chatgpt-oauth")
        const chat = yield* sessions.create()
        yield* sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: account.id })
        const item = yield* provider.getModel(model.providerID, model.id)

        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const original = provider.getLanguage.bind(provider)
        let resolved: { providerID: string; id: string } | undefined
        let selected: string | undefined
        const tap = spyOn(provider, "getLanguage").mockImplementation((requested, profileID) =>
          original(requested, profileID).pipe(
            Effect.tap((language) =>
              Effect.sync(() => {
                resolved = { providerID: requested.providerID, id: requested.id }
                selected = profileID
                expect(language).toBeDefined()
              }),
            ),
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
        )
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(Effect.sync(() => tap.mockRestore()))),
        )

        const agent = {
          name: "qualification",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const pending = yield* LLM.Service.use((svc) =>
          svc
            .stream({
              user: {
                id: MessageID.ascending(),
                sessionID: chat.id,
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: item.providerID, modelID: item.id },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model: item,
              agent,
              system: ["Return a short synthetic result."],
              messages: [{ role: "user" as const, content: "normal request before deletion" }],
              tools: {},
              retries: 0,
            })
            .pipe(Stream.runDrain),
        ).pipe(Effect.exit, Effect.forkChild)

        const handoff = yield* Effect.race(
          Deferred.await(entered).pipe(Effect.as("acquired" as const)),
          Fiber.join(pending).pipe(Effect.map((exit) => ({ ended: exit }))),
        )
        if (handoff !== "acquired")
          throw new Error(`normal LLM ended before Provider.getLanguage: ${String(handoff.ended)}`)
        expect(selected).toBe(account.id)
        expect(resolved).toEqual({ providerID: item.providerID, id: item.id })
        yield* profiles.remove(account.id)
        yield* Deferred.succeed(release, undefined)

        const result = yield* Fiber.join(pending)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(String(result.cause)).toContain("Provider account is unavailable")
        expect(state.calls).toHaveLength(0)
        expect(hook.ambient).toBe(0)
        expect(dir.directory).toBe(chat.directory)
      }),
    (state) =>
      Effect.sync(() => {
        globalThis.fetch = state.fetch
        if (state.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
        if (state.key == null) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = state.key
        if (state.auth == null) delete process.env.KILO_AUTH_CONTENT
        else process.env.KILO_AUTH_CONTENT = state.auth
      }),
  ),
)
