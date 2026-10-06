import { afterEach, expect, spyOn } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { generate as branchName } from "@/kilocode/branch-name"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { Config } from "@/config/config"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"

const model = { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5") }
const cfg = {
  small_model: "openai/gpt-5",
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      options: {},
      models: { "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } } },
    },
  },
}

const graph = testEffect(
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
      [Config.node, TestConfig.layer({ get: () => Effect.succeed(cfg) })],
      [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
    ],
  ),
)

const keys = ["KILO_EXPERIMENTAL_PROVIDER_PROFILES", "OPENAI_API_KEY", "KILO_AUTH_CONTENT", "OPENAI_BASE_URL"] as const
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const fetcher = globalThis.fetch

afterEach(() => {
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
  globalThis.fetch = fetcher
})

function responses(text: string) {
  const events = [
    { type: "response.created", response: { id: "resp_qualification", object: "response", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_qualification", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_qualification",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_qualification",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_text.done", item_id: "msg_qualification", output_index: 0, content_index: 0, text },
    {
      type: "response.content_part.done",
      item_id: "msg_qualification",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_qualification",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_qualification",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_qualification",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

graph.instance("branch-name caller resolves the bound source session through the real OpenAI SDK", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const calls: Array<{ url: string; headers: Headers; body: string }> = []
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "SESSION_CALLER_ENV_POISON"
      process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "SESSION_CALLER_LEGACY_POISON" } })
      delete process.env.OPENAI_BASE_URL
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            headers: new Headers(init?.headers),
            body: String(init?.body ?? ""),
          })
          return responses("fix-session-profile-routing")
        },
        { preconnect: fetcher.preconnect },
      )
      return calls
    }),
    (state) =>
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const sources: unknown[] = []
        const actual = UtilityAccount.resolve.bind(UtilityAccount)
        const resolve = spyOn(UtilityAccount, "resolve").mockImplementation((input) => {
          sources.push(input.context)
          return actual(input)
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => resolve.mockRestore()))
        const sessions = yield* Session.Service
        const source = yield* sessions.create()
        const a = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "source A",
          remoteID: "session-caller-A",
          credential: {
            access: "SESSION_CALLER_A_ACCESS",
            refresh: "SESSION_CALLER_A_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "session-caller-A",
          },
        })
        const b = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "default B",
          remoteID: "session-caller-B",
          credential: {
            access: "SESSION_CALLER_B_ACCESS",
            refresh: "SESSION_CALLER_B_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "session-caller-B",
          },
        })
        yield* sessions.assignBinding({ sessionID: source.id, provider: "openai", profileID: a.id })
        yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)

        const branch = yield* branchName({
          sessionID: source.id,
          messages: ["Implement account-bound branch generation"],
          providerID: model.providerID,
          modelID: model.modelID,
        })

        expect(branch).toBe("fix-session-profile-routing")
        expect(state).toHaveLength(1)
        expect(state[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
        expect(state[0]?.headers.get("authorization")).toBe("Bearer SESSION_CALLER_A_ACCESS")
        expect(state[0]?.headers.get("chatgpt-account-id")).toBe("session-caller-A")
        expect(sources).toEqual([{ kind: "session", sourceSessionID: source.id }])
        expect(JSON.stringify(state)).not.toContain("SESSION_CALLER_B")
        expect(JSON.stringify(state)).not.toContain("POISON")
        expect(b.id).not.toBe(a.id)

        for (const sourceSessionID of ["ses_synthetic_caller", "ses_missing_caller"]) {
          const denied = yield* Effect.exit(
            branchName({
              sessionID: SessionID.make(sourceSessionID),
              messages: ["Implement account-bound branch generation"],
              providerID: model.providerID,
              modelID: model.modelID,
            }),
          )
          expect(denied._tag).toBe("Failure")
        }
        expect(state).toHaveLength(1)
      }),
    () =>
      Effect.sync(() => {
        globalThis.fetch = fetcher
      }),
  ),
)
