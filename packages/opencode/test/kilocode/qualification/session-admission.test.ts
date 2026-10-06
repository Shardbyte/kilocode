import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionCompaction } from "@/session/compaction"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TestLLMServer } from "../../lib/llm-server"
import { testEffect } from "../../lib/effect"
import { pollWithTimeout } from "../../lib/effect"
import { TestInstance, tmpdir } from "../../fixture/fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      ProviderAccountProfiles.node,
      SessionBinding.node,
    ]),
  ),
)

const secret = (name: string) => ({
  access: `SESSION_ADMISSION_ACCESS_${name}`,
  refresh: `SESSION_ADMISSION_REFRESH_${name}`,
  expires: Date.now() + 60_000,
  accountID: `session-admission-${name}`,
})

const enableProfiles = Effect.gen(function* () {
  const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
    }),
  )
})

const testRef = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const serverNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const admission = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      SessionCompaction.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      ProviderAccountProfiles.node,
      Permission.node,
      Question.node,
      FSUtil.node,
      serverNode,
    ]),
  ),
)

const config = Effect.fn("SessionAdmission.config")(function* () {
  const test = yield* TestInstance
  const fs = yield* FSUtil.Service
  const llm = yield* TestLLMServer
  yield* fs.writeWithDirs(
    path.join(test.directory, "opencode.json"),
    JSON.stringify({
      model: "test/test-model",
      enabled_providers: ["test"],
      formatter: false,
      lsp: false,
      provider: {
        test: {
          id: "test",
          name: "Admission Test",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "test-key", baseURL: llm.url },
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
        },
      },
      agent: {
        build: { model: "test/test-model", permission: { bash: "ask", task: "allow" } },
        general: { mode: "subagent", model: "test/test-model", permission: { "*": "allow" } },
      },
    }),
  )
})

test("a restarted backend rejects binding forgery and replay against persisted authority", async () => {
  await using tmp = await tmpdir()
  const fixture = path.join(import.meta.dir, "session-admission-restart.ts")
  const root = path.resolve(import.meta.dir, "../../..")
  const env = {
    ...process.env,
    SESSION_ADMISSION_DB: path.join(tmp.path, "authority.sqlite"),
    SESSION_ADMISSION_HOME: path.join(tmp.path, "home"),
  }
  const run = async (mode: string, ids?: string) => {
    const child = Bun.spawn([process.execPath, fixture, mode], {
      cwd: root,
      env: { ...env, ...(ids ? { SESSION_ADMISSION_IDS: ids } : {}) },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    const line = out.trim().split("\n").at(-1)
    if (!line) throw new Error(`session admission fixture emitted no result\n${err}`)
    return JSON.parse(line) as Record<string, unknown>
  }

  const ids = (await run("seed")) as { sessionID: string; accountID: string; otherID: string; authA: boolean }
  const replay = (await run("replay", JSON.stringify(ids))) as {
    before: { mode: string; profileID: string }
    assignmentStatus: number
    assignmentError: unknown
    after: { mode: string; profileID: string }
    forged: { metadata: { kilocode: { replayProbe: string } } }
    resumed: { info: { error?: unknown }; parts: Array<{ text?: string }> }
    authA: boolean
    account: string
    body: string
  }
  expect(replay.before).toMatchObject({ mode: "profile", profileID: ids.accountID })
  expect(replay.forged.metadata.kilocode.replayProbe).toBe("restarted-process")
  expect(replay.assignmentStatus).toBe(400)
  expect(JSON.stringify(replay.assignmentError)).toContain("Conflict")
  expect(replay.after).toMatchObject({ mode: "profile", profileID: ids.accountID })
  expect(ids.authA).toBe(true)
  expect(replay.resumed.info.error).toBeUndefined()
  expect(replay.resumed.parts.some((part) => part.text?.includes("SESSION_ADMISSION_RESUME_OK"))).toBe(true)
  expect(replay.authA).toBe(true)
  expect(replay.account).toBe("restart-A")
  expect(replay.body).toContain("SESSION_ADMISSION_BEFORE_RESTART")
}, 120_000)

it.instance("a running normal-session turn excludes binding assignment and confirmed repair", () =>
  Effect.gen(function* () {
    const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
      }),
    )
    const profiles = yield* ProviderAccountProfiles.Service
    const sessions = yield* Session.Service
    const a = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "admission-A",
      credential: secret("A"),
    })
    const b = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "admission-B",
      credential: secret("B"),
    })
    yield* profiles.clearDefault("openai", "chatgpt-oauth")
    const chat = yield* sessions.create()
    const entry = { mode: "profile", profileID: a.id, authMode: "chatgpt-oauth", source: "explicit" } as const

    const assigned = yield* Effect.exit(
      sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: a.id }),
    )
    expect(Exit.isSuccess(assigned)).toBe(true)
    yield* profiles.remove(a.id)

    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const fiber = yield* sessions
      .turn(
        chat.id,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(entered)

    const assign = yield* Effect.exit(
      sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: b.id }),
    )
    expect(Exit.isFailure(assign), "assignment during an admitted session turn").toBe(true)
    if (Exit.isFailure(assign)) expect(Cause.squash(assign.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)

    const repair = yield* Effect.exit(
      sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: b.id, confirmRepair: true }),
    )
    expect(Exit.isFailure(repair), "confirmed repair during an admitted session turn").toBe(true)
    if (Exit.isFailure(repair)) expect(Cause.squash(repair.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)

    const repaired = yield* sessions.assignBinding({
      sessionID: chat.id,
      provider: "openai",
      profileID: b.id,
      confirmRepair: true,
    })
    expect(repaired.providers.openai).toEqual({ ...entry, profileID: b.id, source: "repair" })
    yield* profiles.remove(a.id)
    yield* profiles.remove(b.id)
  }),
)

admission.instance(
  "actual pending permission and question requests keep assignment and confirmed repair excluded",
  () =>
    Effect.gen(function* () {
      yield* enableProfiles
      yield* TestInstance
      const profiles = yield* ProviderAccountProfiles.Service
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const llm = yield* TestLLMServer
      yield* config()
      for (const kind of ["permission", "question"] as const) {
        yield* llm.reset
        const chat = yield* sessions.create({ title: `pending ${kind}` })
        if (kind === "permission") {
          yield* llm.tool("bash", { command: "pwd", description: "check directory" })
        } else {
          yield* llm.tool("question", {
            questions: [
              {
                header: "Admission",
                question: "Continue?",
                options: [{ label: "Yes", description: "Continue the test" }],
              },
            ],
          })
        }
        const fiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: testRef,
            parts: [{ type: "text", text: `hold ${kind}` }],
          })
          .pipe(Effect.forkChild)
        const pending =
          kind === "permission"
            ? yield* pollWithTimeout(
                permission.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
                "real permission request did not become pending",
              )
            : yield* pollWithTimeout(
                question.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
                "real question request did not become pending",
              )
        if (!pending) throw new Error(`missing actual ${kind} request`)
        const assign = yield* Effect.exit(
          sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: "qualification-profile" }),
        )
        expect(Exit.isFailure(assign), `${kind}: pending prompt assignment`).toBe(true)
        if (Exit.isFailure(assign)) expect(Cause.squash(assign.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)
        const repair = yield* Effect.exit(
          sessions.assignBinding({
            sessionID: chat.id,
            provider: "openai",
            profileID: "qualification-profile",
            confirmRepair: true,
          }),
        )
        expect(Exit.isFailure(repair), `${kind}: pending prompt repair`).toBe(true)
        if (Exit.isFailure(repair)) expect(Cause.squash(repair.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)

        if (kind === "permission")
          yield* permission.reply({ requestID: PermissionV1.ID.make(pending.id), reply: "reject" })
        else yield* question.reply({ requestID: QuestionID.make(pending.id), answers: [["Yes"]] })
        yield* Fiber.join(fiber)
      }
    }),
)

admission.instance("an active subagent descendant keeps same-parent account repair excluded", () =>
  Effect.gen(function* () {
    yield* enableProfiles
    yield* TestInstance
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const llm = yield* TestLLMServer
    yield* config()
    const chat = yield* sessions.create({ title: "active subagent admission" })
    const gate = Promise.withResolvers<void>()
    yield* llm.tool("task", {
      description: "Run active child",
      prompt: "Keep the child running until the test releases the provider response.",
      subagent_type: "general",
    })
    yield* llm.hold("child provider response", gate.promise)
    yield* llm.text("parent task finished")
    const fiber = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", model: testRef, parts: [{ type: "text", text: "start child" }] })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      llm.inputs.pipe(
        Effect.map((items) =>
          items.some((item) => JSON.stringify(item).includes("Keep the child running")) ? true : undefined,
        ),
      ),
      "subagent prompt did not reach the real provider transport",
    )
    const blocked = yield* Effect.exit(
      sessions.assignBinding({
        sessionID: chat.id,
        provider: "openai",
        profileID: "qualification-profile",
        confirmRepair: true,
      }),
    )
    expect(Exit.isFailure(blocked), "active descendant keeps parent lock held").toBe(true)
    if (Exit.isFailure(blocked)) expect(Cause.squash(blocked.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)
    gate.resolve()
    yield* Fiber.join(fiber)
  }),
)

admission.instance("real compaction provider work excludes assignment and confirmed repair", () =>
  Effect.gen(function* () {
    yield* enableProfiles
    yield* config()
    const sessions = yield* Session.Service
    const compact = yield* SessionCompaction.Service
    const prompt = yield* SessionPrompt.Service
    const llm = yield* TestLLMServer
    const chat = yield* sessions.create({ title: "compaction admission" })
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: testRef,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID: chat.id,
      type: "text",
      text: "summarize this conversation",
    })
    yield* compact.create({ sessionID: chat.id, agent: "build", model: testRef, auto: false })
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const parent = msgs.at(-1)?.info
    if (!parent || parent.role !== "user") throw new Error("compaction did not create its input message")

    const gate = Promise.withResolvers<void>()
    yield* llm.hold("compaction summary", gate.promise)
    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)

    const assign = yield* Effect.exit(
      sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: "qualification-profile" }),
    )
    expect(Exit.isFailure(assign), "compaction assignment admission").toBe(true)
    if (Exit.isFailure(assign)) expect(Cause.squash(assign.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)
    const repair = yield* Effect.exit(
      sessions.assignBinding({
        sessionID: chat.id,
        provider: "openai",
        profileID: "qualification-profile",
        confirmRepair: true,
      }),
    )
    expect(Exit.isFailure(repair), "compaction confirmed-repair admission").toBe(true)
    if (Exit.isFailure(repair)) expect(Cause.squash(repair.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)
    gate.resolve()
    yield* Fiber.join(fiber)
  }),
)
