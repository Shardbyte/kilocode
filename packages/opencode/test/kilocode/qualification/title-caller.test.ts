import { afterEach, expect } from "bun:test"
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
import { Deferred, Effect, Fiber, Layer } from "effect"
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
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { responses } from "./title-caller.fixture"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"

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
  [Auth.node, Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined), all: () => Effect.succeed({}) })],
])
const it = testEffect(env)

const ref = { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5") }
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

it.instance(
  "automatic title generation resolves the real session binding through OpenAI Responses SDK",
  () =>
    Effect.gen(function* () {
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "TITLE_CALLER_ENV_POISON"
      process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "TITLE_CALLER_LEGACY_POISON" } })
      delete process.env.OPENAI_BASE_URL
      const calls: Array<{ url: string; headers: Headers; body: string }> = []
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = String(init?.body ?? "")
          calls.push({
            url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            headers: new Headers(init?.headers),
            body,
          })
          const prior = calls.filter((call) => call.url === "https://chatgpt.com/backend-api/codex/responses").length
          return responses(prior === 2 ? "TITLE_CALLER_TITLE" : "TITLE_CALLER_ASSISTANT")
        },
        { preconnect: fetcher.preconnect },
      )

      const { directory } = yield* TestInstance
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(directory, "kilo.json"),
        JSON.stringify({
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
        }),
      )
      const cfg = yield* Config.Service
      const info = yield* cfg.get()
      expect(info.small_model).toBe("openai/gpt-5-mini")
      const agent = yield* (yield* Agent.Service).get("title")
      expect(agent).toBeDefined()

      const profiles = yield* ProviderAccountProfiles.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create()
      expect(Session.isDefaultTitle(chat.title)).toBe(true)
      const a = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "title A",
        remoteID: "title-caller-A",
        credential: {
          access: "TITLE_CALLER_A_ACCESS",
          refresh: "TITLE_CALLER_A_REFRESH",
          expires: Date.now() + 60_000,
          accountID: "title-caller-A",
        },
      })
      const b = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "default B",
        remoteID: "title-caller-B",
        credential: {
          access: "TITLE_CALLER_B_ACCESS",
          refresh: "TITLE_CALLER_B_REFRESH",
          expires: Date.now() + 60_000,
          accountID: "title-caller-B",
        },
      })
      yield* sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: a.id })
      yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)

      const title = yield* Deferred.make<void>()
      const unsub = subscribeAll((event) => {
        if (
          event.type === Session.Event.Updated.type &&
          JSON.stringify(event).includes(chat.id) &&
          JSON.stringify(event).includes("TITLE_CALLER_TITLE")
        )
          return Effect.runPromise(Deferred.succeed(title, undefined))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsub))
      const prompt = yield* SessionPrompt.Service
      const llm = yield* LLM.Service
      const streams: string[] = []
      const stream = llm.stream
      ;(llm as { stream: LLM.Interface["stream"] }).stream = (input) => {
        streams.push(`${input.agent.name}:${input.model.id}`)
        return stream(input)
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => ((llm as { stream: LLM.Interface["stream"] }).stream = stream)),
      )
      const turn = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [
            { type: "text", text: `TITLE_CALLER_USER_PROMPT ${"describe the implementation precisely ".repeat(12)}` },
          ],
        })
        .pipe(Effect.forkChild)
      yield* Fiber.join(turn)
      yield* Deferred.await(title).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.gen(function* () {
              const fresh = yield* sessions.get(chat.id)
              return yield* Effect.fail(
                new Error(JSON.stringify({ title: fresh.title, calls: calls.map((call) => call.url), streams })),
              )
            }),
        }),
      )
      const fresh = yield* sessions.get(chat.id)
      expect(fresh.title).toBe("TITLE_CALLER_TITLE")
      expect(Session.isDefaultTitle(fresh.title)).toBe(false)
      const titleCalls = calls.filter((call) => call.body.includes("Generate a title for this conversation"))
      expect(
        calls.filter((call) => call.url === "https://chatgpt.com/backend-api/codex/responses").map((call) => call.url),
      ).toEqual(["https://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com/backend-api/codex/responses"])
      expect(titleCalls).toHaveLength(1)
      for (const call of calls.filter((item) => item.url === "https://chatgpt.com/backend-api/codex/responses")) {
        expect(call.headers.get("authorization")).toBe("Bearer TITLE_CALLER_A_ACCESS")
        expect(call.headers.get("chatgpt-account-id")).toBe("title-caller-A")
        expect(call.body).not.toContain("TITLE_CALLER_B")
      }
      expect(JSON.stringify(calls)).not.toContain("POISON")
      expect(b.id).not.toBe(a.id)
    }),
  40_000,
)
