import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
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
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { EnhancePromptRuntime, INSTRUCTION } from "@/kilocode/enhance-prompt"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"
import { TestInstance, tmpdir } from "../../fixture/fixture"
import { Effect, Fiber, Layer, Stream } from "effect"

const model = { providerID: ProviderV2.ID.openai, id: ModelV2.ID.make("gpt-5") }
const config = {
  small_model: "openai/gpt-5",
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      options: {
        fetch: async () => {
          throw new Error("ambient configured fetch must not receive profile requests")
        },
      },
      models: { "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } } },
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

it.instance(
  "real Session/LLM A and enhancement B preserve account identity at concurrent provider handoffs during reauth",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          key: process.env.OPENAI_API_KEY,
          auth: process.env.KILO_AUTH_CONTENT,
          fetch: globalThis.fetch,
        }
        const calls: Array<{ bearer: string | null; account: string | null; url: string }> = []
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "LIFECYCLE_ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "LIFECYCLE_LEGACY_POISON" } })
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const headers = new Headers(
              init?.headers ?? (typeof input === "string" || input instanceof URL ? undefined : input.headers),
            )
            const count = calls.push({
              url,
              bearer: headers.get("authorization"),
              account: headers.get("chatgpt-account-id"),
            })
            if (count === 2) entered.resolve()
            await release.promise
            return Response.json({
              id: `resp_lifecycle_${count}`,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "completed",
              model: "gpt-5",
              output: [
                {
                  id: `msg_lifecycle_${count}`,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "synthetic completion", annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            })
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls, entered, release }
      }),
      (state) =>
        Effect.gen(function* () {
          const dir = yield* TestInstance
          const profiles = yield* ProviderAccountProfiles.Service
          const sessions = yield* Session.Service
          const a = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "lifecycle A",
            remoteID: "lifecycle-A",
            credential: {
              access: "LIFECYCLE_A_OLD",
              refresh: "LIFECYCLE_A_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "lifecycle-A",
            },
          })
          const b = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "lifecycle B",
            remoteID: "lifecycle-B",
            credential: {
              access: "LIFECYCLE_B",
              refresh: "LIFECYCLE_B_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "lifecycle-B",
            },
          })
          yield* profiles.clearDefault("openai", "chatgpt-oauth")
          const chat = yield* sessions.create()
          yield* sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: a.id })

          const provider = yield* Provider.Service
          const item = yield* provider.getModel(model.providerID, model.id)
          const util = yield* UtilityAccount.standalone({
            operation: "enhance-prompt",
            model: item,
            context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
          })
          expect(util.mode).toBe("profile")
          if (util.mode !== "profile") throw new Error("utility did not resolve account B")
          const lang = yield* provider.getLanguage(item, util.profileID)
          const agent = {
            name: "qualification",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const normal = LLM.Service.use((svc) =>
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
                system: ["Answer only with the synthetic test result."],
                messages: [{ role: "user" as const, content: "normal A request" }],
                tools: {},
                retries: 0,
              })
              .pipe(Stream.runDrain),
          )
          const utility = Effect.tryPromise(() =>
            EnhancePromptRuntime.generate({
              model: lang,
              system: INSTRUCTION,
              prompt: "rewrite the B draft",
              maxRetries: 0,
            }),
          )
          const one = yield* normal.pipe(Effect.forkChild)
          const two = yield* utility.pipe(Effect.forkChild)
          yield* Effect.promise(() => state.entered.promise)
          yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
          yield* profiles.reauthenticate({
            id: a.id,
            revision: 0,
            remoteID: "lifecycle-A",
            value: {
              access: "LIFECYCLE_A_NEW",
              refresh: "LIFECYCLE_A_NEW_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "lifecycle-A",
            },
          })
          state.release.resolve()
          yield* Fiber.join(one)
          yield* Fiber.join(two)

          const again = LLM.Service.use((svc) =>
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
                system: ["Answer only with the synthetic test result."],
                messages: [{ role: "user" as const, content: "normal A retry" }],
                tools: {},
                retries: 0,
              })
              .pipe(Stream.runDrain),
          )
          yield* Effect.all([again, utility], { concurrency: 2 })
          const pairs = state.calls.map((call) => [call.account, call.bearer])
          expect(pairs.slice(0, 2)).toContainEqual(["lifecycle-A", "Bearer LIFECYCLE_A_OLD"])
          expect(pairs.slice(0, 2)).toContainEqual(["lifecycle-B", "Bearer LIFECYCLE_B"])
          expect(pairs).toContainEqual(["lifecycle-A", "Bearer LIFECYCLE_A_NEW"])
          expect(pairs.filter(([account]) => account === "lifecycle-B")).toHaveLength(2)
          expect(
            pairs.filter(([account, bearer]) => account === "lifecycle-A" && bearer === "Bearer LIFECYCLE_A_OLD"),
          ).toHaveLength(1)
          expect(
            pairs.filter(([account, bearer]) => account === "lifecycle-A" && bearer === "Bearer LIFECYCLE_A_NEW"),
          ).toHaveLength(1)
          expect(state.calls.every((call) => call.url === "https://chatgpt.com/backend-api/codex/responses")).toBe(true)
          expect(JSON.stringify(state.calls)).not.toContain("POISON")
          expect(JSON.stringify(state.calls)).not.toContain("LIFECYCLE_A_REFRESH")
          expect(JSON.stringify(state.calls)).not.toContain("LIFECYCLE_B_REFRESH")
          expect(yield* profiles.credential(a.id)).toMatchObject({ revision: 1, value: { access: "LIFECYCLE_A_NEW" } })
          expect((yield* profiles.credential(b.id))?.value.access).toBe("LIFECYCLE_B")
          expect(dir.directory).toBe(chat.directory)
        }),
      (state) =>
        Effect.sync(() => {
          state.release.resolve()
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

it.instance("a same-profile SDK refresh waiter observes reauthentication and does not dispatch stale credentials", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = {
        flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
        key: process.env.OPENAI_API_KEY,
        fetch: globalThis.fetch,
      }
      const entered = Promise.withResolvers<void>()
      const waited = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<Response>()
      const calls: Array<{ bearer: string | null; account: string | null }> = []
      let count = 0
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "LIFECYCLE_REFRESH_ENV_POISON"
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url === "https://auth.openai.com/oauth/token") {
            count++
            entered.resolve()
            return gate.promise
          }
          const headers = new Headers(
            init?.headers ?? (typeof input === "string" || input instanceof URL ? undefined : input.headers),
          )
          calls.push({ bearer: headers.get("authorization"), account: headers.get("chatgpt-account-id") })
          return Response.json({
            id: "resp_refresh_waiter",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model: "gpt-5",
            output: [
              {
                id: "msg_refresh_waiter",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "synthetic completion", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: prior.fetch.preconnect },
      )
      return { ...prior, entered, waited, gate, calls, count: () => count }
    }),
    (state) =>
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const profile = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "refresh waiter",
          remoteID: "refresh-wait-A",
          credential: {
            access: "LIFECYCLE_REFRESH_OLD",
            refresh: "LIFECYCLE_REFRESH_TOKEN",
            expires: 0,
            accountID: "refresh-wait-A",
          },
        })
        const provider = yield* Provider.Service
        const item = yield* provider.getModel(model.providerID, model.id)
        const language = yield* provider.getLanguage(item, profile.id)
        const original = profiles.withRefresh.bind(profiles)
        let entrants = 0
        const tap = spyOn(profiles, "withRefresh").mockImplementation((id, effect) => {
          entrants++
          if (entrants === 2) state.waited.resolve()
          return original(id, effect)
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => tap.mockRestore()))
        const prompt = {
          prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "refresh waiter" }] }],
        }
        const one = yield* Effect.tryPromise(() => language.doGenerate(prompt)).pipe(Effect.exit, Effect.forkChild)
        const two = yield* Effect.tryPromise(() => language.doGenerate(prompt)).pipe(Effect.exit, Effect.forkChild)
        yield* Effect.promise(() => state.entered.promise)
        yield* Effect.promise(() => state.waited.promise)
        yield* profiles.reauthenticate({
          id: profile.id,
          revision: 0,
          remoteID: "refresh-wait-A",
          value: {
            access: "LIFECYCLE_REFRESH_REAUTH",
            refresh: "LIFECYCLE_REFRESH_REAUTH_TOKEN",
            expires: Date.now() + 60_000,
            accountID: "refresh-wait-A",
          },
        })
        state.gate.resolve(
          Response.json({
            access_token: "LIFECYCLE_REFRESH_STALE",
            refresh_token: "LIFECYCLE_REFRESH_STALE_TOKEN",
            expires_in: 3600,
          }),
        )
        const exits = [yield* Fiber.join(one), yield* Fiber.join(two)]
        expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(1)
        expect(exits.filter((exit) => exit._tag === "Failure")).toHaveLength(1)
        expect(state.count()).toBe(1)
        expect(state.calls).toEqual([{ account: "refresh-wait-A", bearer: "Bearer LIFECYCLE_REFRESH_REAUTH" }])
        expect(yield* profiles.credential(profile.id)).toMatchObject({
          revision: 1,
          value: { access: "LIFECYCLE_REFRESH_REAUTH" },
        })
      }),
    (state) =>
      Effect.sync(() => {
        state.gate.resolve(Response.json({ access_token: "cleanup", refresh_token: "cleanup", expires_in: 1 }))
        globalThis.fetch = state.fetch
        if (state.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
        if (state.key == null) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = state.key
      }),
  ),
)

it.instance(
  "profile deletion is checked before account lookup, after language acquisition, after HTTP handoff, and on retry",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          key: process.env.OPENAI_API_KEY,
          fetch: globalThis.fetch,
        }
        const calls: Array<{ bearer: string | null; account: string | null }> = []
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "LIFECYCLE_DELETE_ENV_POISON"
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(
              init?.headers ?? (typeof input === "string" || input instanceof URL ? undefined : input.headers),
            )
            const count = calls.push({
              bearer: headers.get("authorization"),
              account: headers.get("chatgpt-account-id"),
            })
            if (count === 2) entered.resolve()
            await release.promise
            return Response.json({
              id: `resp_delete_${count}`,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "completed",
              model: "gpt-5",
              output: [
                {
                  id: `msg_delete_${count}`,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "synthetic completion", annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            })
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls, entered, release }
      }),
      (state) =>
        Effect.gen(function* () {
          const profiles = yield* ProviderAccountProfiles.Service
          const sessions = yield* Session.Service
          const provider = yield* Provider.Service
          const a = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "delete before acquisition",
            credential: {
              access: "DELETE_BEFORE_ACCESS",
              refresh: "DELETE_BEFORE_REFRESH",
              expires: Date.now() + 60_000,
            },
          })
          yield* profiles.clearDefault("openai", "chatgpt-oauth")
          const chat = yield* sessions.create()
          yield* sessions.assignBinding({ sessionID: chat.id, provider: "openai", profileID: a.id })
          yield* profiles.remove(a.id)
          const item = yield* provider.getModel(model.providerID, model.id)
          const agent = {
            name: "qualification",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const stream = (sid: SessionID, text: string) =>
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: {
                    id: MessageID.ascending(),
                    sessionID: sid,
                    role: "user",
                    time: { created: Date.now() },
                    agent: agent.name,
                    model: { providerID: item.providerID, modelID: item.id },
                  } satisfies SessionV1.User,
                  sessionID: sid,
                  model: item,
                  agent,
                  system: ["Answer only with the synthetic test result."],
                  messages: [{ role: "user" as const, content: text }],
                  tools: {},
                  retries: 0,
                })
                .pipe(Stream.runDrain),
            )
          expect((yield* Effect.exit(stream(chat.id, "deleted before account lookup")))._tag).toBe("Failure")
          const b = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "delete after SDK acquisition",
            credential: {
              access: "DELETE_AFTER_ACCESS",
              refresh: "DELETE_AFTER_REFRESH",
              expires: Date.now() + 60_000,
            },
          })
          const identity = yield* UtilityAccount.standalone({
            operation: "enhance-prompt",
            model: item,
            context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
          })
          if (identity.mode !== "profile") throw new Error("utility account did not resolve as a profile")
          const acquired = yield* provider.getLanguage(item, identity.profileID)
          yield* profiles.remove(b.id)
          const afterAcquire = yield* Effect.exit(
            Effect.tryPromise(() =>
              acquired.doGenerate({
                prompt: [{ role: "user", content: [{ type: "text", text: "removed after model acquisition" }] }],
              }),
            ),
          )

          expect(afterAcquire._tag).toBe("Failure")
          expect(state.calls).toHaveLength(0)

          const c = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "delete after handoff A",
            remoteID: "delete-handoff-A",
            credential: {
              access: "DELETE_HANDOFF_A",
              refresh: "DELETE_HANDOFF_A_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "delete-handoff-A",
            },
          })
          const d = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "delete after handoff B",
            remoteID: "delete-handoff-B",
            credential: {
              access: "DELETE_HANDOFF_B",
              refresh: "DELETE_HANDOFF_B_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "delete-handoff-B",
            },
          })
          const la = yield* provider.getLanguage(item, c.id)
          const db = yield* provider.getLanguage(item, d.id)
          const prompt = {
            prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "handed request" }] }],
          }
          const pa = Effect.tryPromise(() => la.doGenerate(prompt))
          const pb = Effect.tryPromise(() => db.doGenerate(prompt))
          const fa = yield* pa.pipe(Effect.forkChild)
          const fb = yield* pb.pipe(Effect.forkChild)
          yield* Effect.promise(() => state.entered.promise)
          yield* profiles.remove(c.id)
          yield* profiles.remove(d.id)
          state.release.resolve()
          yield* Fiber.join(fa)
          yield* Fiber.join(fb)
          expect(state.calls.map((call) => [call.account, call.bearer])).toEqual([
            ["delete-handoff-A", "Bearer DELETE_HANDOFF_A"],
            ["delete-handoff-B", "Bearer DELETE_HANDOFF_B"],
          ])
          const retryA = yield* Effect.exit(Effect.tryPromise(() => la.doGenerate(prompt)))
          const retryB = yield* Effect.exit(Effect.tryPromise(() => db.doGenerate(prompt)))
          expect(retryA._tag).toBe("Failure")
          expect(retryB._tag).toBe("Failure")
          expect(state.calls).toHaveLength(2)
        }),
      (state) =>
        Effect.sync(() => {
          state.release.resolve()
          globalThis.fetch = state.fetch
          if (state.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
          else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
          if (state.key == null) delete process.env.OPENAI_API_KEY
          else process.env.OPENAI_API_KEY = state.key
        }),
    ),
)

test("independent SDK process assignment and confirmed repair are denied while the real SQLite session turn is held", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  await mkdir(home, { recursive: true })
  const worker = path.join(import.meta.dir, "lifecycle-process-worker.ts")
  const cwd = path.resolve(import.meta.dir, "../../..")
  const owner = Bun.spawn([process.execPath, worker, "owner", tmp.path, home], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  type Msg = {
    event: string
    pid?: number
    profileExists?: boolean
    sessionID?: string
    freshID?: string
    otherID?: string
    assignment?: { status?: number; error?: unknown }
    repair?: { status?: number; error?: unknown }
  }
  const read = (child: typeof owner) => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    return async () => {
      while (true) {
        while (!buf.includes("\n")) {
          const item = await reader.read()
          if (item.done)
            throw new Error(`Process worker exited (${await child.exited}): ${await new Response(child.stderr).text()}`)
          buf += decoder.decode(item.value, { stream: true })
        }
        const at = buf.indexOf("\n")
        const line = buf.slice(0, at)
        buf = buf.slice(at + 1)
        if (!line.startsWith("LIFECYCLE_PROCESS ")) continue
        return JSON.parse(line.slice("LIFECYCLE_PROCESS ".length)) as Msg
      }
    }
  }
  const next = read(owner)
  try {
    const ready = await next()
    expect(ready).toMatchObject({ event: "turn-held" })
    if (!ready.sessionID || !ready.freshID || !ready.otherID)
      throw new Error("owner did not publish session/profile IDs")
    const child = Bun.spawn(
      [process.execPath, worker, "contender", tmp.path, home, ready.sessionID, ready.freshID, ready.otherID],
      {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const result = await read(child)()
    expect(await child.exited).toBe(0)
    expect(result.event).toBe("admissions")
    expect(result.pid).not.toBe(ready.pid)
    expect(result.profileExists).toBe(true)
    expect(result.assignment).toMatchObject({ status: 400 })
    expect(JSON.stringify(result.assignment?.error)).toMatch(/turn|session provider/i)
    expect(result.repair).toMatchObject({ status: 400 })
    expect(JSON.stringify(result.repair?.error)).toMatch(/turn|session provider/i)
    await owner.stdin.write(`${JSON.stringify({ type: "release" })}\n`)
    expect(await next()).toMatchObject({ event: "owner-released" })
    expect(await owner.exited).toBe(0)
  } finally {
    if (owner.exitCode === null) {
      owner.kill(9)
      await owner.exited
    }
  }
}, 120_000)

test("real SDK normal Session A and utility B dispatch concurrently with isolated handoff credentials", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  await mkdir(home, { recursive: true })
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "lifecycle-sdk-worker.ts"), tmp.path, home], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const next = async () => {
    while (true) {
      while (!buf.includes("\n")) {
        const item = await reader.read()
        if (item.done)
          throw new Error(
            `SDK lifecycle worker exited (${await child.exited}): ${await new Response(child.stderr).text()}`,
          )
        buf += decoder.decode(item.value, { stream: true })
      }
      const at = buf.indexOf("\n")
      const line = buf.slice(0, at)
      buf = buf.slice(at + 1)
      if (line === "LIFECYCLE_SDK_READY") return { event: "ready" }
      if (!line.startsWith("LIFECYCLE_SDK ")) continue
      return JSON.parse(line.slice("LIFECYCLE_SDK ".length)) as {
        event: string
        calls: Array<{ bearer: string | null; account: string | null; url: string }>
        statuses?: Array<number | undefined>
      }
    }
  }
  try {
    const handoff = await next()
    expect(handoff.event).toBe("handoff")
    if (!("calls" in handoff)) throw new Error("SDK handoff did not include transport calls")
    expect(handoff.calls).toHaveLength(2)
    await child.stdin.write("release\n")
    const ready = await next()
    expect(ready.event).toBe("ready")
    const result = await next()
    expect(result.event).toBe("result")
    if (!("calls" in result)) throw new Error("SDK result did not include transport calls")
    const pairs = result.calls.map((call) => [call.account, call.bearer])
    expect(pairs).toContainEqual(["lifecycle-sdk-A", "Bearer LIFECYCLE_SDK_A_OLD"])
    expect(pairs).toContainEqual(["lifecycle-sdk-B", "Bearer LIFECYCLE_SDK_B"])
    expect(pairs).toContainEqual(["lifecycle-sdk-A", "Bearer LIFECYCLE_SDK_A_NEW"])
    expect(pairs).toHaveLength(4)
    expect(result.calls.every((call) => call.url === "https://chatgpt.com/backend-api/codex/responses")).toBe(true)
    expect(JSON.stringify(result.calls)).not.toContain("POISON")
    expect(JSON.stringify(result.calls)).not.toContain("LIFECYCLE_SDK_A_REFRESH")
    expect(JSON.stringify(result.calls)).not.toContain("LIFECYCLE_SDK_B_REFRESH")
    expect(await child.exited).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill(9)
    await child.exited
  }
}, 120_000)

test("real SDK normal Session A and utility B retain handed requests after deletion and reject retries", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  await mkdir(home, { recursive: true })
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "lifecycle-sdk-worker.ts"), tmp.path, home, "delete"],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const next = async () => {
    while (true) {
      while (!buf.includes("\n")) {
        const item = await reader.read()
        if (item.done)
          throw new Error(
            `SDK lifecycle worker exited (${await child.exited}): ${await new Response(child.stderr).text()}`,
          )
        buf += decoder.decode(item.value, { stream: true })
      }
      const at = buf.indexOf("\n")
      const line = buf.slice(0, at)
      buf = buf.slice(at + 1)
      if (line === "LIFECYCLE_SDK_READY") return { event: "ready" }
      if (line.startsWith("LIFECYCLE_SDK "))
        return JSON.parse(line.slice("LIFECYCLE_SDK ".length)) as {
          event: string
          mode?: string
          calls: Array<{ bearer: string | null; account: string | null; url: string }>
          completed?: Array<number | undefined>
          retries?: Array<number | undefined | string>
        }
    }
  }
  try {
    expect((await next()).event).toBe("handoff")
    const ready = await next()
    expect(ready.event).toBe("ready")
    await child.stdin.write("release\n")
    const result = await next()
    expect(result).toMatchObject({ event: "result", mode: "delete" })
    if (!("calls" in result)) throw new Error("SDK deletion result did not include transport calls")
    expect(result.completed, JSON.stringify(result)).toEqual([200, 200])
    expect(result.retries).toEqual([200, 200])
    const pairs = result.calls.map((call) => [call.account, call.bearer])
    expect(pairs).toContainEqual(["lifecycle-sdk-A", "Bearer LIFECYCLE_SDK_A_OLD"])
    expect(pairs.filter(([account]) => account === "lifecycle-sdk-B")).toHaveLength(2)
    expect(pairs).toHaveLength(3)
    expect(pairs.filter(([account]) => account === "lifecycle-sdk-A")).toHaveLength(1)
    expect(await child.exited).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill(9)
    await child.exited
  }
}, 120_000)
