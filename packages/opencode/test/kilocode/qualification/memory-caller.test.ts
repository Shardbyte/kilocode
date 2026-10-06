import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { provide } from "@/kilocode/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { MemoryTurn } from "@/kilocode/memory/turn"
import { KiloMemory } from "@kilocode/kilo-memory/effect"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { MemoryPaths } from "@kilocode/kilo-memory/effect/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { tmpdir } from "../../fixture/fixture"
import { memoryFetch, type WireCall } from "./memory-caller.fixture"

test("actual memory close persists a source-A fact through the real Responses SDK", async () => {
  await using tmp = await tmpdir({
    config: {
      small_model: "openai/gpt-5",
      provider: { openai: { models: { "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } } } } },
    },
  })
  const keys = ["KILO_EXPERIMENTAL_PROVIDER_PROFILES", "OPENAI_API_KEY", "KILO_AUTH_CONTENT"] as const
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const fetcher = globalThis.fetch
  const calls: WireCall[] = []
  const ids: string[] = []
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.OPENAI_API_KEY = "MEMORY_ENV_POISON"
  process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "MEMORY_LEGACY_POISON" } })
  globalThis.fetch = memoryFetch(calls, fetcher)
  const ctx = { directory: tmp.path, worktree: tmp.path }
  try {
    await KiloMemory.enable({ ctx })
    await provide({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const profiles = yield* ProviderAccountProfiles.Service
            const sessions = yield* Session.Service
            const provider = yield* Provider.Service
            const create = (label: string, account: string) =>
              profiles.create({
                provider: "openai",
                authMode: "chatgpt-oauth",
                label,
                remoteID: account,
                credential: {
                  access: `MEMORY_${label}_ACCESS`,
                  refresh: `MEMORY_${label}_REFRESH`,
                  expires: Date.now() + 60_000,
                  accountID: account,
                },
              })
            const a = yield* create("A", "memory-source-A")
            ids.push(a.id)
            yield* profiles.clearDefault("openai", "chatgpt-oauth")
            const source = yield* sessions.create()
            yield* sessions.assignBinding({ sessionID: source.id, provider: "openai", profileID: a.id })
            const b = yield* create("B", "memory-default-B")
            ids.push(b.id)
            yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: source.id,
              agent: "build",
              model: { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5") },
              time: { created: Date.now() },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: source.id,
              type: "text",
              text: "Remember this durable project workflow: run CLI tests from packages/opencode, not from the repository root.",
            })
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              sessionID: source.id,
              parentID: user.id,
              modelID: ModelV2.ID.make("gpt-5"),
              providerID: ProviderV2.ID.openai,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now(), completed: Date.now() + 1 },
              finish: "stop",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: source.id,
              type: "text",
              text: "The durable workflow is to run bun test from packages/opencode when testing CLI behavior.",
            })
            const summary = {
              summarize: () => Effect.void,
              diff: () => Effect.succeed([]),
              computeDiff: () => Effect.succeed([]),
            } as unknown as import("@/session/summary").SessionSummary.Interface
            yield* MemoryTurn.close({ sessionID: source.id, reason: "completed", sessions, summary, provider })
          }).pipe(Effect.provideService(MemoryService.Service, MemoryService.make())),
        ),
    })
    const sdk = calls.filter((call) => call.url === "https://chatgpt.com/backend-api/codex/responses")
    expect(sdk.length).toBeGreaterThan(0)
    expect(
      sdk.every(
        (call) =>
          call.headers.get("authorization") === "Bearer MEMORY_A_ACCESS" &&
          call.headers.get("chatgpt-account-id") === "memory-source-A",
      ),
    ).toBe(true)
    const wire = JSON.stringify(sdk.map((call) => ({ ...call, headers: Object.fromEntries(call.headers) })))
    expect(wire).not.toContain("POISON")
    expect(wire).not.toContain("MEMORY_B")
    expect(wire).not.toContain("MEMORY_A_REFRESH")
    const content = await MemoryFiles.readSource(MemoryPaths.root({ ctx }), "project.md")
    expect(content).toContain("memory_test_command")
  } finally {
    try {
      await AppRuntime.runPromise(
        ProviderAccountProfiles.Service.use((profiles) => Effect.forEach(ids, (id) => profiles.remove(id))),
      )
      await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeDirectory(tmp.path)))
    } finally {
      globalThis.fetch = fetcher
      for (const key of keys) {
        if (prior[key] == null) delete process.env[key]
        else process.env[key] = prior[key]
      }
    }
  }
}, 60_000)
