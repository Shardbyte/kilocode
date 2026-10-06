import { afterEach, expect, spyOn } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { ModelsDev } from "@/provider/models"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { subscribeAll } from "@/bus"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { responses } from "./title-caller.fixture"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { MessageID, PartID } from "@/session/schema"

const mcp = Layer.mock(MCP.Service)({
  status: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
  tools: () => Effect.succeed({}),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  resourceTemplates: () => Effect.succeed({}),
  add: () => Effect.succeed({ status: { status: "disabled" as const } }),
  connect: () => Effect.void,
  disconnect: () => Effect.void,
  getPrompt: () => Effect.succeed(undefined),
  readResource: () => Effect.succeed(undefined),
  startAuth: () => Effect.die("unexpected MCP auth"),
  authenticate: () => Effect.die("unexpected MCP auth"),
  finishAuth: () => Effect.die("unexpected MCP auth"),
  removeAuth: () => Effect.void,
  supportsOAuth: () => Effect.succeed(false),
  hasStoredTokens: () => Effect.succeed(false),
  getAuthStatus: () => Effect.succeed("not_authenticated" as const),
})
const lsp = Layer.mock(LSP.Service)({})
const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
const memory = LayerNode.make({ service: MemoryService.Service, layer: MemoryService.layer, deps: [] })
const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  ProviderAccountProfiles.node,
  SessionBinding.node,
  ModelsDev.node,
  memory,
])
const env = AppNodeBuilder.build(root, [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true })],
  [KiloSessions.node, KiloSessions.testLayer],
  [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
  [
    Auth.node,
    Layer.mock(Auth.Service)({
      get: () =>
        Effect.succeed({
          type: "oauth" as const,
          access: "COMPACTION_LEGACY_OAUTH_POISON",
          refresh: "COMPACTION_LEGACY_REFRESH_POISON",
          expires: Date.now() + 60_000,
        }),
      all: () =>
        Effect.succeed({
          openai: {
            type: "oauth" as const,
            access: "COMPACTION_LEGACY_OAUTH_POISON",
            refresh: "COMPACTION_LEGACY_REFRESH_POISON",
            expires: Date.now() + 60_000,
          },
        }),
    }),
  ],
])
const it = testEffect(env)

const keys = ["KILO_EXPERIMENTAL_PROVIDER_PROFILES", "OPENAI_API_KEY", "KILO_AUTH_CONTENT"] as const
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const fetcher = globalThis.fetch

afterEach(() => {
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
  globalThis.fetch = fetcher
})

it.instance(
  "actual compaction loop uses the bound account through native-mode Responses SDK",
  () =>
    Effect.gen(function* () {
      const native = spyOn(LLMNativeRuntime, "stream")
      yield* Effect.addFinalizer(() => Effect.sync(() => native.mockRestore()))
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "COMPACTION_CALLER_ENV_POISON"
      process.env.KILO_AUTH_CONTENT = JSON.stringify({
        openai: { type: "api", key: "COMPACTION_CALLER_LEGACY_POISON" },
      })
      const calls: Array<{ url: string; headers: Headers; body: string }> = []
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            headers: new Headers(init?.headers),
            body: String(init?.body ?? ""),
          })
          return responses("COMPACTION_CALLER_SUMMARY")
        },
        { preconnect: fetcher.preconnect },
      )

      const { directory } = yield* TestInstance
      const fs = yield* FSUtil.Service
      const config: Record<string, unknown> = {
        model: "openai/gpt-5",
        small_model: "openai/gpt-5-mini",
        enabled_providers: ["openai"],
        formatter: false,
        lsp: false,
        provider: {
          openai: {
            id: "openai",
            name: "OpenAI",
            npm: "@ai-sdk/openai",
            env: ["OPENAI_API_KEY"],
            options: {},
            models: {
              "gpt-5": { id: "gpt-5", name: "GPT-5", limit: { context: 128000, output: 4096 } },
              "gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 mini", limit: { context: 128000, output: 4096 } },
            },
          },
        },
      }
      yield* fs.writeWithDirs(path.join(directory, "kilo.json"), JSON.stringify(config))
      const cfg = yield* Config.Service
      expect((yield* cfg.get()).small_model).toBe("openai/gpt-5-mini")

      const profiles = yield* ProviderAccountProfiles.Service
      const sessions = yield* Session.Service
      const a = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "compaction source A",
        remoteID: "compaction-source-A",
        credential: {
          access: "COMPACTION_CALLER_A_ACCESS",
          refresh: "COMPACTION_CALLER_A_REFRESH",
          expires: Date.now() + 60_000,
          accountID: "compaction-source-A",
        },
      })
      const b = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "default B",
        remoteID: "compaction-default-B",
        credential: {
          access: "COMPACTION_CALLER_B_ACCESS",
          refresh: "COMPACTION_CALLER_B_REFRESH",
          expires: Date.now() + 60_000,
          accountID: "compaction-default-B",
        },
      })
      yield* Effect.addFinalizer(() => profiles.remove(a.id).pipe(Effect.orDie))
      yield* Effect.addFinalizer(() => profiles.remove(b.id).pipe(Effect.orDie))
      yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)

      const main = { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5") }
      const events: unknown[] = []
      const unsub = subscribeAll((event) => {
        if (event.type === SessionCompaction.Event.Compacted.type) events.push(event)
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsub))
      const compaction = yield* SessionCompaction.Service
      const prompt = yield* SessionPrompt.Service
      const run = (name: string) =>
        Effect.gen(function* () {
          yield* profiles.selectDefault("openai", "chatgpt-oauth", a.id)
          const source = yield* sessions.create({ title: name })
          yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: source.id,
            agent: "build",
            model: main,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: source.id,
            type: "text",
            text: "COMPACTION_CALLER_INPUT preserve this source-session fact.",
          })
          yield* compaction.create({ sessionID: source.id, agent: "build", model: main, auto: false })
          yield* prompt.loop({ sessionID: source.id })
          const msgs = yield* sessions.messages({ sessionID: source.id })
          return { source, msgs }
        })
      const inherited = yield* run("compaction inherited main model")

      config.agent = { compaction: { model: "openai/gpt-5-mini" } }
      yield* fs.writeWithDirs(path.join(directory, "kilo.json"), JSON.stringify(config))
      yield* cfg.invalidate()
      const explicit = yield* run("compaction explicit small model")

      const sdk = calls.filter((call) => call.url === "https://chatgpt.com/backend-api/codex/responses")
      expect(sdk).toHaveLength(2)
      expect(calls).toHaveLength(2)
      expect(native).not.toHaveBeenCalled()
      expect(events).toHaveLength(2)
      for (const call of sdk) {
        expect(call.headers.get("authorization")).toBe("Bearer COMPACTION_CALLER_A_ACCESS")
        expect(call.headers.get("chatgpt-account-id")).toBe("compaction-source-A")
        expect(call.body).toContain("COMPACTION_CALLER_INPUT")
        expect(call.body).toContain("Create a new anchored summary")
      }
      const result = (msgs: typeof inherited.msgs, id: string) => {
        const parent = msgs.find(
          (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"),
        )
        return msgs.find(
          (msg) => msg.info.role === "assistant" && msg.info.parentID === parent?.info.id && msg.info.sessionID === id,
        )
      }
      const old = result(inherited.msgs, inherited.source.id)
      const mini = result(explicit.msgs, explicit.source.id)
      for (const item of [old, mini]) {
        expect(item?.info.role).toBe("assistant")
        if (item?.info.role !== "assistant") throw new Error("compaction summary was not persisted")
        expect(item.info.summary).toBe(true)
        expect(item.info.finish).toBe("stop")
        expect(item.parts.some((part) => part.type === "text" && part.text.includes("COMPACTION_CALLER_SUMMARY"))).toBe(
          true,
        )
      }
      const wire = JSON.stringify(calls.map((call) => ({ ...call, headers: Object.fromEntries(call.headers) })))
      expect(wire).not.toContain("COMPACTION_CALLER_B")
      expect(wire).not.toContain("POISON")
      expect(wire).not.toContain("COMPACTION_CALLER_A_REFRESH")
      expect(old?.info.role === "assistant" ? old.info.modelID : undefined).toBe(ModelV2.ID.make("gpt-5"))
      expect(mini?.info.role === "assistant" ? mini.info.modelID : undefined).toBe(ModelV2.ID.make("gpt-5-mini"))
      expect(sdk.at(0)?.body).toContain('"model":"gpt-5"')
      expect(sdk.at(1)?.body).toContain('"model":"gpt-5-mini"')
    }),
  40_000,
)
