import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"
import { BackgroundJob } from "../../src/background/job"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { messages, parse, generate } from "../../src/kilocode/branch-name"
import { SessionDrain } from "../../src/kilocode/session/drain"
import { SessionStatus } from "../../src/session/status"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "../../src/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const started = Promise.withResolvers<void>()
const resume = Promise.withResolvers<string>()
const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 mini",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 16_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const infra = LayerNode.compile(
  LayerNode.group([
    BackgroundJob.node,
    EventV2Bridge.node,
    EventV2.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    ProviderAccountProfiles.node,
    SessionBinding.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionDrain.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
)
const layer = Layer.mergeAll(
  infra,
  Layer.mock(Provider.Service, { getSmallModel: () => Effect.succeed(model) }),
  Layer.mock(LLM.Service, {
    stream: () =>
      Stream.fromEffect(
        Effect.promise(async () => {
          started.resolve()
          const text = await resume.promise
          return { type: "text-delta", id: "branch-name-text", text } as LLMEvent
        }),
      ),
  }),
)
const it = testEffect(layer)

afterEach(async () => {
  await disposeAllInstances()
})

function user(text: string, synthetic = false): MessageV2.WithParts {
  const sessionID = SessionID.make("ses_branch_name_test")
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: {
        providerID: ProviderV2.ID.make("kilo"),
        modelID: ModelV2.ID.make("kilo-auto/small"),
      },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID,
        type: "text",
        text,
        synthetic,
      },
    ],
  }
}

describe("branch name generation helpers", () => {
  test("sanitizes model output into a safe branch segment", () => {
    expect(parse("fix-token-refresh-race")).toBe("fix-token-refresh-race")
    expect(parse("Fix OAuth / Token Refresh!")).toBe("fix-oauth-token-refresh")
    expect(parse("feature")).toBe("feature")
    expect(parse("null")).toBeNull()
    expect(parse("!!!")).toBeNull()
  })

  test("removes reasoning wrappers before parsing", () => {
    expect(parse("<think>Choose a durable outcome</think>\nadd-health-check-endpoint")).toBe(
      "add-health-check-endpoint",
    )
    expect(parse("<THINK>Choose a durable outcome</THINK>\nadd-health-check-endpoint")).toBe(
      "add-health-check-endpoint",
    )
  })

  test("uses recent real user messages and appends the pending prompt once", () => {
    const history = [user("hi"), user("internal", true), user("Can you inspect auth?")]
    expect(messages(history, "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix the token refresh race",
    ])
    expect(messages([...history, user("Fix the token refresh race")], "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix the token refresh race",
    ])
    expect(messages([...history, user("Fix   the token refresh race")], "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix   the token refresh race",
    ])
  })

  test("keeps only the latest four user messages", () => {
    const history = [user("one"), user("two"), user("three"), user("four"), user("five")]
    expect(messages(history, "six")).toEqual(["three", "four", "five", "six"])
  })

  test("truncates large messages before generation", () => {
    const big = "x".repeat(2_000)

    expect(messages([user(big)], big)).toEqual(["x".repeat(1_000)])
  })
})

it.instance("holds source-session turn admission through OpenAI branch-name generation", () =>
  Effect.gen(function* () {
    const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (before === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
      }),
    )
    const profiles = yield* ProviderAccountProfiles.Service
    const first = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "First",
      remoteID: "remote-first",
      credential: { access: "access-first", refresh: "refresh-first", expires: Date.now() + 60_000 },
    })
    yield* profiles.selectDefault("openai", "chatgpt-oauth", first.id)
    const second = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Second",
      remoteID: "remote-second",
      credential: { access: "access-second", refresh: "refresh-second", expires: Date.now() + 60_000 },
    })
    const sessions = yield* Session.Service
    const source = yield* sessions.create()
    const running = yield* generate({
      sessionID: source.id,
      messages: ["Fix session turn race"],
      providerID: model.providerID,
      modelID: model.id,
    }).pipe(Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    const denied = yield* Effect.exit(
      sessions.assignBinding({ sessionID: source.id, provider: "openai", profileID: second.id, confirmRepair: true }),
    )
    expect(Exit.isFailure(denied)).toBe(true)
    if (Exit.isFailure(denied)) expect(Cause.squash(denied.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)

    resume.resolve("fix-session-turn-race")
    expect(yield* Fiber.join(running)).toBe("fix-session-turn-race")
    yield* profiles.remove(first.id)
    const changed = yield* sessions.assignBinding({
      sessionID: source.id,
      provider: "openai",
      profileID: second.id,
      confirmRepair: true,
    })
    expect(changed.providers.openai).toMatchObject({ mode: "profile", profileID: second.id })
  }),
)
