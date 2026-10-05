import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect" // kilocode_change - Cause for resume-hint coverage
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding" // kilocode_change
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles" // kilocode_change
import { EventV2 } from "@opencode-ai/core/event" // kilocode_change
import { EventTable } from "@opencode-ai/core/event/sql" // kilocode_change
import { SessionTable } from "@opencode-ai/core/session/sql" // kilocode_change
import { and, asc, eq } from "drizzle-orm" // kilocode_change
import { MessageV2 } from "@/session/message-v2" // kilocode_change
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema" // kilocode_change - SessionID used by cost propagation tests
import { SessionRunState } from "@/session/run-state"
import { SessionDrain } from "@/kilocode/session/drain" // kilocode_change
import { SessionStatus } from "@/session/status"
import { Provider } from "../../src/provider/provider" // kilocode_change
import { KiloSession } from "../../src/kilocode/session" // kilocode_change
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      EventV2.node, // kilocode_change
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      ProviderAccountProfiles.node, // kilocode_change
      SessionBinding.node, // kilocode_change
      SessionProjector.node,
      SessionRunState.node,
      SessionDrain.node, // kilocode_change
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Provider.node, // kilocode_change
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = it // kilocode_change - background subagents are enabled by default

// kilocode_change start - provider binding regression fixtures
const secret = (tag: string): ProviderAccountProfiles.Secret => ({
  access: `access-${tag}`,
  refresh: `refresh-${tag}`,
  expires: 1_900_000_000_000,
  accountID: `remote-${tag}`,
})

const legacyFixture = Effect.fn("TaskToolTest.legacyFixture")(function* (sessionID: SessionID) {
  const db = yield* Database.Service
  yield* db.db.update(SessionTable).set({ metadata: null }).where(eq(SessionTable.id, sessionID)).run()
  const row = yield* db.db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, EventV2.versionedType(SessionV1.Event.Created.type, 1)),
      ),
    )
    .get()
  if (!row) throw new Error("expected old session Created event")
  const data = structuredClone(row.data)
  const info = data.info as Record<string, unknown>
  delete info.metadata
  yield* db.db.update(EventTable).set({ data }).where(eq(EventTable.id, row.id)).run()
})
// kilocode_change end

const disabled = testEffect(layer({ experimentalBackgroundSubagents: false })) // kilocode_change

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

// kilocode_change start - session provider-binding lifecycle regression coverage
it.instance(
  "session creation snapshots the default into the durable Created event and forks inherit that snapshot",
  () =>
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
        credential: secret("first"),
      })
      yield* profiles.selectDefault("openai", "chatgpt-oauth", first.id)
      const sessions = yield* Session.Service
      const second = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Second",
        credential: secret("second"),
      })
      const db = yield* Database.Service
      const events = yield* EventV2.Service
      const change = { active: true }
      yield* events.project(SessionV1.Event.Created, () =>
        Effect.gen(function* () {
          if (!change.active) return
          change.active = false
          yield* profiles.selectDefault("openai", "chatgpt-oauth", second.id).pipe(Effect.orDie)
        }),
      )
      const parent = yield* sessions.create({
        metadata: {
          unrelated: "caller metadata",
          kilocode: {
            callerValue: true,
            providerBindings: {
              version: 1,
              providers: { openai: { mode: "legacy", authMode: "api-key", source: "explicit" } },
            },
          },
        },
      })
      const pinned: SessionBinding.Entry = {
        mode: "profile",
        profileID: first.id,
        authMode: "chatgpt-oauth",
        source: "default",
      }
      expect(SessionBinding.get(parent.metadata)?.providers.openai).toEqual(pinned)
      expect(parent.metadata).toMatchObject({ unrelated: "caller metadata", kilocode: { callerValue: true } })
      expect(yield* profiles.getDefault("openai", "chatgpt-oauth")).toBe(second.id)
      expect(SessionBinding.get((yield* sessions.get(parent.id)).metadata)?.providers.openai).toEqual(pinned)

      delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      const child = yield* sessions.create({ parentID: parent.id })
      const fork = yield* sessions.fork({ sessionID: parent.id })
      expect(SessionBinding.get(child.metadata)?.providers.openai).toEqual(pinned)
      expect(SessionBinding.get(fork.metadata)?.providers.openai).toEqual(pinned)

      const row = yield* db.db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, parent.id),
            eq(EventTable.type, EventV2.versionedType(SessionV1.Event.Created.type, 1)),
          ),
        )
        .get()
      expect(row).toBeDefined()
      if (!row) throw new Error("expected durable Created event")
      const info = row.data.info as Record<string, unknown>
      const replayID = SessionID.descending()
      const replayInfo = { ...info, id: replayID }
      const replayData = { ...row.data, sessionID: replayID, info: replayInfo }
      yield* events.replay({
        id: EventV2.ID.create(),
        type: row.type,
        seq: 0,
        aggregateID: replayID,
        data: replayData,
      })
      expect(SessionBinding.get((yield* sessions.get(replayID)).metadata)?.providers.openai).toEqual(pinned)
    }),
)
// kilocode_change end

// kilocode_change start - session provider-binding lifecycle regression coverage
it.instance("session binding migration persists once and cannot assign during an admitted turn", () =>
  Effect.gen(function* () {
    const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (before !== undefined) process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
      }),
    )
    const profiles = yield* ProviderAccountProfiles.Service
    const target = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Target",
      credential: secret("target"),
    })
    yield* profiles.clearDefault("openai", "chatgpt-oauth")
    const sessions = yield* Session.Service
    const chat = yield* sessions.create()
    const unknown = yield* sessions.create()
    const busy = yield* sessions.create()
    expect(SessionBinding.get(busy.metadata)?.providers.openai).toEqual({
      mode: "legacy",
      authMode: "legacy",
      source: "explicit",
    })
    yield* legacyFixture(chat.id)
    yield* legacyFixture(unknown.id)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const fiber = yield* sessions
      .turn(
        busy.id,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const denied = yield* Effect.exit(
      sessions.assignBinding({ sessionID: busy.id, provider: "openai", profileID: target.id }),
    )
    expect(denied._tag).toBe("Failure")
    if (denied._tag === "Failure") expect(Cause.squash(denied.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)

    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const implicitLegacy = yield* Effect.exit(
      sessions.assignBinding({
        sessionID: unknown.id,
        provider: "openai",
        profileID: target.id,
        confirmRepair: true,
      }),
    )
    expect(implicitLegacy._tag).toBe("Failure")
    if (implicitLegacy._tag === "Failure")
      expect(Cause.squash(implicitLegacy.cause)).toBeInstanceOf(SessionBinding.ConflictError)
    const migrated = yield* sessions.migrateLegacyBinding({
      sessionID: chat.id,
      provider: "openai",
      authMode: "oauth",
      accountID: "legacy-account-current-at-migration",
    })
    expect(migrated.providers.openai).toEqual({
      mode: "legacy",
      authMode: "oauth",
      accountID: "legacy-account-current-at-migration",
      source: "migration",
    })
    const again = yield* Effect.exit(
      sessions.migrateLegacyBinding({
        sessionID: chat.id,
        provider: "openai",
        authMode: "oauth",
        accountID: "legacy-account-current-at-migration",
      }),
    )
    expect(again._tag).toBe("Failure")
    if (again._tag === "Failure") expect(Cause.squash(again.cause)).toBeInstanceOf(SessionBinding.ConflictError)
    const legacySwitch = yield* Effect.exit(
      sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: target.id, confirmRepair: true }),
    )
    expect(legacySwitch._tag).toBe("Failure")
    if (legacySwitch._tag === "Failure")
      expect(Cause.squash(legacySwitch.cause)).toBeInstanceOf(SessionBinding.ConflictError)

    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const other = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Other",
      credential: secret("other"),
    })
    yield* profiles.clearDefault("openai", "chatgpt-oauth")
    const healthy = yield* sessions.create()
    expect(SessionBinding.get(healthy.metadata)?.providers.openai).toMatchObject({ mode: "unbound" })
    yield* sessions.assignBinding({ sessionID: healthy.id, provider: "openai", profileID: target.id })
    const healthySwitch = yield* Effect.exit(
      sessions.assignBinding({ sessionID: healthy.id, provider: "openai", profileID: other.id, confirmRepair: true }),
    )
    expect(healthySwitch._tag).toBe("Failure")
    if (healthySwitch._tag === "Failure")
      expect(Cause.squash(healthySwitch.cause)).toBeInstanceOf(SessionBinding.ConflictError)

    const old = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Deleted target",
      credential: secret("deleted"),
    })
    yield* profiles.clearDefault("openai", "chatgpt-oauth")
    const repair = yield* sessions.create()
    yield* sessions.assignBinding({ sessionID: repair.id, provider: "openai", profileID: old.id })
    yield* profiles.remove(old.id)
    const unconfirmed = yield* Effect.exit(
      sessions.assignBinding({ sessionID: repair.id, provider: "openai", profileID: target.id }),
    )
    expect(unconfirmed._tag).toBe("Failure")
    if (unconfirmed._tag === "Failure")
      expect(Cause.squash(unconfirmed.cause)).toBeInstanceOf(SessionBinding.ConflictError)
    expect(
      yield* sessions.assignBinding({
        sessionID: repair.id,
        provider: "openai",
        profileID: target.id,
        confirmRepair: true,
      }),
    ).toMatchObject({
      providers: { openai: { mode: "profile", profileID: target.id, source: "repair" } },
    })

    const db = yield* Database.Service
    const row = yield* db.db
      .select()
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, chat.id),
          eq(EventTable.type, EventV2.versionedType(SessionV1.Event.Updated.type, 1)),
        ),
      )
      .get()
    expect(row?.data.info).toMatchObject({
      metadata: {
        kilocode: {
          providerBindings: {
            providers: { openai: { mode: "legacy", accountID: "legacy-account-current-at-migration" } },
          },
        },
      },
    })
    const rows = yield* db.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, chat.id))
      .orderBy(asc(EventTable.seq))
      .all()
    const replayID = SessionID.descending()
    const replay = rows.map((item) => {
      const info = item.data.info as Record<string, unknown>
      return {
        id: EventV2.ID.create(),
        type: item.type,
        seq: item.seq,
        aggregateID: replayID,
        data: { ...item.data, sessionID: replayID, info: { ...info, id: replayID } },
      } satisfies EventV2.SerializedEvent
    })
    yield* (yield* EventV2.Service).replayAll(replay)
    expect(SessionBinding.get((yield* sessions.get(replayID)).metadata)?.providers.openai).toEqual(
      migrated.providers.openai,
    )
  }),
)
// kilocode_change end

// kilocode_change start - stub signature + prompt body extended to persist assistant cost for propagation tests
function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  sessions?: Session.Interface
  childCost?: number
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        opts?.onPrompt?.(input)
        const rep = reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
        if (opts?.sessions && opts?.childCost != null) {
          yield* opts.sessions.updateMessage({ ...rep.info, cost: opts.childCost })
        }
        return rep
      }),
  }
}
// kilocode_change end

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  // kilocode_change start - verify forked task children remain resumable
  it.instance("execute resumes a cloned task session after the parent is forked", () =>
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
      const profile = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Fork source",
        credential: secret("fork-source"),
      })
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      expect(SessionBinding.get(chat.metadata)?.providers.openai).toMatchObject({
        mode: "profile",
        profileID: profile.id,
      })
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "call_1",
        tool: "task",
        metadata: { sessionId: child.id },
        state: {
          status: "completed",
          input: { description: "inspect bug", prompt: "continue", task_id: child.id },
          output: `<task id="${child.id}"><task_result>done</task_result></task>`,
          title: "inspect bug",
          metadata: { sessionId: child.id },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)

      const forked = yield* sessions.fork({ sessionID: chat.id })
      expect(SessionBinding.get((yield* sessions.get(forked.id)).metadata)?.providers.openai).toEqual(
        SessionBinding.get((yield* sessions.get(chat.id)).metadata)?.providers.openai,
      ) // kilocode_change
      const msgs = yield* sessions.messages({ sessionID: forked.id })
      const part = msgs.flatMap((msg) => msg.parts).find((item) => item.type === "tool" && item.tool === "task") as
        | MessageV2.ToolPart
        | undefined
      if (!part || part.state.status !== "completed") throw new Error("expected a completed task part")
      const id = part.state.input.task_id
      if (typeof id !== "string") throw new Error("expected a cloned task ID")
      const parent = msgs.find((msg) => msg.info.role === "assistant")
      if (!parent || parent.info.role !== "assistant") throw new Error("expected a forked assistant message")

      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "continue from the fork",
          subagent_type: "general",
          task_id: id,
        },
        {
          sessionID: forked.id,
          messageID: parent.info.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.sessionID).toBe(SessionID.descending(id))
      expect((yield* sessions.get(SessionID.descending(id))).parentID).toBe(forked.id)
      expect(SessionBinding.get((yield* sessions.get(SessionID.descending(id))).metadata)?.providers.openai).toEqual(
        SessionBinding.get((yield* sessions.get(child.id)).metadata)?.providers.openai,
      ) // kilocode_change
    }),
  )
  // kilocode_change end

  // kilocode_change start - resumed children rebuild parent platform attribution after restart
  it.instance("execute preserves platform attribution when resuming a task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      KiloSession.setPlatformOverride(chat.id, "agent-manager")
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      KiloSession.clearPlatformOverride(child.id)
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "continue",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(KiloSession.resolvePlatform(child.id)).toBe("agent-manager")
      expect(KiloSession.resolveRoot(child.id)).toBe(chat.id)
    }),
  )
  // kilocode_change end

  // kilocode_change start - preserve upstream terminal child failure coverage with Kilo's resume hint
  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toContain("Network connection lost")
      expect(failure.message).toContain(`task_id="${child?.id}"`)
      expect(failure.message).toContain("can be resumed")
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toContain("The user rejected permission to use this specific tool call.")
      expect(failure.message).toContain(`task_id="${child?.id}"`)
      expect(failure.message).toContain("can be resumed")
    }),
  )
  // kilocode_change end

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      // kilocode_change start - enable profile binding and verify task child inheritance
      const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (before === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
        }),
      )
      const profiles = yield* ProviderAccountProfiles.Service
      const profile = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Task source",
        credential: secret("task-source"),
      })
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      expect(SessionBinding.get(chat.metadata)?.providers.openai).toMatchObject({
        mode: "profile",
        profileID: profile.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(SessionBinding.get(kids[0]?.metadata)?.providers.openai).toEqual(
        SessionBinding.get((yield* sessions.get(chat.id)).metadata)?.providers.openai,
      )
      // kilocode_change end
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  // kilocode_change start - regression for #13469: a trailing synthetic empty text part (the memory marker)
  // or an ignored length-warning part must not be picked as the task result
  it.instance("returns the real answer when synthetic or ignored text parts trail it", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.sync(() => {
            const rep = reply(input, "the actual answer")
            const id = MessageID.ascending()
            return {
              ...rep,
              parts: [
                ...rep.parts,
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: "output limit hit",
                  ignored: true,
                },
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: "",
                  synthetic: true,
                  ignored: true,
                },
              ],
            }
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("the actual answer")
      expect(result.output).not.toContain("output limit hit")
      expect(result.output).not.toContain("<task_result></task_result>")
    }),
  )
  // kilocode_change end

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        // kilocode_change start — use arrayContaining: Kilo appends inherited caller restrictions
        expect(child.permission).toEqual(
          expect.arrayContaining([
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "read",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "task",
              pattern: "*",
              action: "deny",
            },
          ]),
        )
        // kilocode_change end
        expect(seen?.tools).toEqual({
          question: false, // kilocode_change - subagents cannot prompt the user directly
          todowrite: false,
          task: false, // kilocode_change - Kilo disallows nested subagents
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
          openTelemetry: true, // kilocode_change
        },
      },
    },
  )

  // kilocode_change start - terminal child assistant errors fail the task tool boundary
  it.instance("execute fails when child prompt returns assistant error", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            const result = reply(input, "partial")
            if (result.info.role !== "assistant") return result
            return {
              ...result,
              info: {
                ...result.info,
                error: MessageV2.fromError(new Error("child prompt failed"), { providerID: ref.providerID }),
              },
            }
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)

      // the failure surfaces the resumable task_id so the parent can continue the subagent (#11620)
      const kids = yield* sessions.children(chat.id)
      const childId = kids[0]?.id
      expect(childId).toBeDefined()
      const squashed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      const message = squashed instanceof Error ? squashed.message : String(squashed)
      expect(message).toContain("child prompt failed")
      expect(message).toContain(`task_id="${childId}"`)
      expect(message).toContain("can be resumed")
    }),
  )
  // kilocode_change end

  // kilocode_change start - background subagent failures also surface the resumable task_id (#11620)
  background.instance("background task failure injects a resumable task_id into the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected: SessionPrompt.PromptInput[] = []
      const parentInjected = yield* Deferred.make<void>()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => {
                // The parent-session prompt is the injected background result; capture it.
                if (input.sessionID === chat.id) {
                  injected.push(input)
                  return Effect.as(Deferred.succeed(parentInjected, undefined), reply(input, "ack"))
                }
                return Effect.die(new Error("child prompt failed and can be resumed later"))
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const childId = result.metadata.sessionId
      yield* jobs.wait({ id: childId, timeout: 1_000 })
      // The parent-session injection is forked asynchronously; wait for it before asserting.
      yield* Deferred.await(parentInjected).pipe(Effect.timeout("1 second"))

      const text = injected
        .flatMap((input) => input.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
      expect(text).toContain(`state="error"`)
      expect(text).toContain(`task_id="${childId}"`)
      expect(text).toContain("can be resumed")
    }),
  )
  // kilocode_change end
  // kilocode_change start - preserve the disabled-background regression test
  disabled.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  // kilocode_change end

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  // kilocode_change start - completed background tasks propagate their invocation cost delta
  background.instance("background tasks propagate child cost to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ sessions, childCost: 0.2 }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
      expect(parent.info.role === "assistant" ? parent.info.cost : 0).toBeCloseTo(0.2, 6)
    }),
  )
  // kilocode_change end

  // kilocode_change start - the background.extend() path must also propagate its run's cost delta (regression)
  background.instance("extended background tasks propagate the extended run's cost to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      let childPrompts = 0
      // Each child prompt persists a 0.2 cost delta, so the child session totals 0.2 after the
      // initial run and 0.4 after the extended run. Blocking each run keeps the job "running"
      // long enough for the second execute() to hit background.extend() rather than a fresh start.
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            const rep = reply(input, "done")
            if (input.sessionID === chat.id) return rep
            yield* sessions.updateMessage({ ...rep.info, cost: 0.2 })
            childPrompts++
            if (childPrompts === 1) yield* Effect.promise(() => first.promise)
            else yield* Effect.promise(() => second.promise)
            return rep
          }),
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const extended = yield* def.execute(
        {
          description: "extend investigation",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )
      expect(extended.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(extended.output).toContain("Background task updated")

      first.resolve()
      second.resolve()
      yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
      // Both the initial run and the extended run propagate their 0.2 delta; a missing bracket on the
      // extend path would leave the parent at 0.2.
      expect(parent.info.role === "assistant" ? parent.info.cost : 0).toBeCloseTo(0.4, 6)
    }),
  )
  // kilocode_change end

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})

// kilocode_change start - subagent cost propagation coverage (#6321)
const assistantCost = Effect.fn("TaskToolTest.assistantCost")(function* (sessionID: string) {
  const sessions = yield* Session.Service
  const msgs = yield* sessions.messages({ sessionID: SessionID.make(sessionID) })
  return msgs.reduce((sum, m) => sum + (m.info.role === "assistant" ? m.info.cost : 0), 0)
})

describe("tool.task cost propagation", () => {
  it.live("propagates subagent cost to parent assistant message", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps = stubOps({ sessions, childCost: 0.25 })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        expect(parent.info.role).toBe("assistant")
        if (parent.info.role !== "assistant") return
        expect(parent.info.cost).toBeCloseTo(0.25, 6)
      }),
    ),
  )

  it.live("propagates recursively through nested subagent costs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        // Pre-create a child with its own assistant already bearing a grandchild cost.
        const child = yield* sessions.create({ parentID: chat.id, title: "grandchild-accumulated" })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: assistant.id,
          sessionID: child.id,
          mode: "build",
          agent: "general",
          cost: 0.4,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })

        const tool = yield* TaskTool
        const def = yield* tool.init()
        // Resuming into the same child via task_id and the stub tacks on another 0.15.
        const promptOps = stubOps({ sessions, childCost: 0.15 })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        if (parent.info.role !== "assistant") return
        // Only the delta since the start of this invocation propagates.
        expect(parent.info.cost).toBeCloseTo(0.15, 6)
        // Child session keeps the full cumulative total (0.4 pre-existing + 0.15 this run).
        expect(yield* assistantCost(child.id)).toBeCloseTo(0.55, 6)
      }),
    ),
  )

  it.live("resumed task_id only propagates the delta", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "resume target" })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: assistant.id,
          sessionID: child.id,
          mode: "build",
          agent: "general",
          cost: 0.1,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })

        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps = stubOps({ sessions, childCost: 0.05 })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "continue investigation",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        if (parent.info.role !== "assistant") return
        // Delta-only: only the 0.05 from this run, not 0.15 including the pre-existing 0.10.
        expect(parent.info.cost).toBeCloseTo(0.05, 6)
      }),
    ),
  )

  it.live("propagates partial cost on abort", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const abort = new AbortController()
        // Stub that persists a partial cost, then aborts — mimics interrupted run after tokens billed.
        const ops: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              const info: MessageV2.Assistant = {
                id: MessageID.ascending(),
                role: "assistant",
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                mode: "general",
                agent: "general",
                cost: 0.07,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ref.modelID,
                providerID: ref.providerID,
                time: { created: Date.now() },
              }
              yield* sessions.updateMessage(info)
              abort.abort()
              return yield* Effect.interrupt
            }),
        }

        yield* def
          .execute(
            {
              description: "partial",
              prompt: "will abort",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: abort.signal,
              extra: { promptOps: ops },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        if (parent.info.role !== "assistant") return
        expect(parent.info.cost).toBeCloseTo(0.07, 6)
      }),
    ),
  )
})
// kilocode_change end
