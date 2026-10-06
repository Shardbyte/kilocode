import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import * as Stream from "effect/Stream"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { createKiloClient } from "@kilocode/sdk/v2"
import { ExportCommand } from "@/cli/cmd/export"
import { AppRuntime } from "@/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { EventV2 } from "@opencode-ai/core/event"
import { testEffect } from "../lib/effect"
import { Client } from "../../../kilo-telemetry/src/client"
import { TelemetryEvent } from "@kilocode/kilo-telemetry"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      ProviderAccountProfiles.node,
      SessionBinding.node,
    ]),
  ),
)
const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES

beforeEach(() => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
})

afterEach(() => {
  if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
})

const secret = (name: string, expires = Date.now() + 60_000) => ({
  access: `QUALIFICATION_ACCESS_${name}`,
  refresh: `QUALIFICATION_REFRESH_${name}`,
  expires,
  accountID: `remote-${name}`,
})

const profile = Effect.fn("SessionAuthorityQualification.profile")(function* (label: string, expires?: number) {
  const profiles = yield* ProviderAccountProfiles.Service
  return yield* profiles.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label,
    remoteID: `remote-${label}`,
    credential: secret(label, expires),
  })
})

const bind = Effect.fn("SessionAuthorityQualification.bind")(function* (
  sessionID: Session.Info["id"],
  profileID: string,
) {
  const sessions = yield* Session.Service
  return yield* sessions.assignBinding({ sessionID, provider: "openai", profileID })
})

describe("session provider authority qualification", () => {
  it.instance("serializes real turns against assignment and only repairs objectively missing profiles", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* profile("repair-A")
      const b = yield* profile("repair-B")
      yield* profiles.clearDefault("openai", "chatgpt-oauth")
      const chat = yield* sessions.create()
      yield* bind(chat.id, a.id)

      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const turn = yield* sessions
        .turn(
          chat.id,
          Effect.promise(async () => {
            entered.resolve()
            await release.promise
          }),
        )
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const blocked = yield* Effect.exit(bind(chat.id, b.id))
      expect(blocked._tag).toBe("Failure")
      if (Exit.isFailure(blocked)) expect(Cause.squash(blocked.cause)).toBeInstanceOf(SessionBinding.TurnActiveError)
      release.resolve()
      yield* Fiber.join(turn)

      // Expiry, a quota response, and a rejected network response do not
      // delete the bound profile or its credential row; none permits repair.
      const expired = yield* profile("repair-expired", 0)
      const quota = yield* profiles.dispatch(a.id, () => Promise.resolve(new Response(null, { status: 429 })))
      expect((yield* Effect.promise(() => quota.response)).status).toBe(429)
      const network = yield* profiles.dispatch(a.id, () => Promise.reject(new Error("network unavailable")))
      const offline = yield* Effect.exit(Effect.promise(() => network.response))
      expect(offline._tag).toBe("Failure")
      for (const target of [expired, b]) {
        const denied = yield* Effect.exit(
          sessions.assignBinding({
            sessionID: chat.id,
            provider: "openai",
            profileID: target.id,
            confirmRepair: true,
          }),
        )
        expect(denied._tag).toBe("Failure")
        if (Exit.isFailure(denied)) expect(Cause.squash(denied.cause)).toBeInstanceOf(SessionBinding.ConflictError)
      }

      yield* profiles.remove(a.id)
      const repaired = yield* sessions.assignBinding({
        sessionID: chat.id,
        provider: "openai",
        profileID: b.id,
        confirmRepair: true,
      })
      expect(repaired.providers.openai).toEqual({
        mode: "profile",
        profileID: b.id,
        authMode: "chatgpt-oauth",
        source: "repair",
      })
      expect(yield* sessions.binding(chat.id)).toEqual(repaired)
    }),
  )

  it.instance("keeps replay, child, and fork authority pinned through profile lifecycle changes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* profile("resume-A")
      const b = yield* profile("resume-B")
      yield* profiles.clearDefault("openai", "chatgpt-oauth")
      const parent = yield* sessions.create()
      yield* bind(parent.id, a.id)
      yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)

      const child = yield* sessions.create({ parentID: parent.id })
      const fork = yield* sessions.fork({ sessionID: parent.id })
      expect((yield* sessions.binding(child.id))?.providers.openai).toMatchObject({ mode: "profile", profileID: a.id })
      expect((yield* sessions.binding(fork.id))?.providers.openai).toMatchObject({
        mode: "profile",
        profileID: a.id,
      })

      yield* profiles.rename(a.id, "resume-A-renamed")
      const cred = yield* profiles.credential(a.id)
      if (!cred) throw new Error("expected persisted profile credential")
      yield* profiles.compareAndSwapCredential({
        id: a.id,
        revision: cred.revision,
        value: secret("resume-A-refreshed"),
      })
      yield* profiles.remove(b.id)
      yield* sessions.setMetadata({
        sessionID: parent.id,
        metadata: { kilocode: { display: { pinned: true }, providerBindings: { version: 99, providers: {} } } },
      })

      for (const sessionID of [parent.id, child.id, fork.id]) {
        const binding = yield* sessions.binding(sessionID)
        expect(binding?.providers.openai).toMatchObject({ mode: "profile", profileID: a.id })
        expect(yield* sessions.ensureBinding({ sessionID, provider: "openai" })).toMatchObject({
          mode: "profile",
          profileID: a.id,
        })
      }
      expect((yield* sessions.get(parent.id)).metadata?.kilocode).toMatchObject({ display: { pinned: true } })

      const textID = MessageID.make("msg_export_probe")
      yield* sessions.updateMessage({
        id: textID,
        sessionID: parent.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-5-mini") },
      } satisfies SessionV1.User)
      yield* sessions.updatePart({
        id: PartID.make("prt_export_probe"),
        sessionID: parent.id,
        messageID: textID,
        type: "text",
        text: "non-secret replay payload",
        metadata: { annotation: "non-secret" },
      })
    }),
  )

  it.instance("strips client binding injection on create and preserves server authority on metadata updates", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* profile("injection-A")
      yield* profiles.clearDefault("openai", "chatgpt-oauth")
      const injected = {
        kilocode: {
          providerBindings: {
            version: 1,
            providers: {
              openai: { mode: "profile", profileID: "client-forged", authMode: "chatgpt-oauth", source: "explicit" },
            },
          },
          display: { keep: true },
        },
      }
      const untrusted = yield* sessions.create({ metadata: injected })
      expect((yield* sessions.binding(untrusted.id))?.providers.openai).not.toMatchObject({
        profileID: "client-forged",
      })

      yield* bind(untrusted.id, a.id)
      yield* sessions.setMetadata({ sessionID: untrusted.id, metadata: injected })
      expect((yield* sessions.binding(untrusted.id))?.providers.openai).toMatchObject({ profileID: a.id })
      expect((yield* sessions.get(untrusted.id)).metadata?.kilocode).toMatchObject({ display: { keep: true } })

      const messageID = MessageID.make("msg_authority_probe")
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: untrusted.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-5-mini") },
      } satisfies SessionV1.User)
      yield* sessions.updatePart({
        id: PartID.make("prt_authority_probe"),
        sessionID: untrusted.id,
        messageID,
        type: "text",
        text: "untrusted message metadata",
        metadata: injected.kilocode,
      })
      expect((yield* sessions.messages({ sessionID: untrusted.id })).length).toBe(1)
      expect((yield* sessions.binding(untrusted.id))?.providers.openai).toMatchObject({ profileID: a.id })
    }),
  )

  test("keeps backend profile credentials out of HTTP info/messages, update events, and CLI export", async () => {
    const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    await using tmp = await tmpdir({ git: true })
    const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
    const a = await AppRuntime.runPromise(profile("surface-A"))
    const b = await AppRuntime.runPromise(profile("surface-B"))
    await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))
    const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const sdk = createKiloClient({ baseUrl: `http://${server.hostname}:${server.port}`, headers: ServerAuth.headers() })
    const dir = tmp.path
    const markers = [secret("surface-A"), secret("surface-B"), secret("surface-A-refreshed")]
    const events: unknown[] = []
    const outputs: string[] = []
    const write = process.stdout.write
    const cwd = process.cwd()
    try {
      const parentResponse = await sdk.session.create({ directory: dir, title: "surface qualification" })
      if (!parentResponse.data) throw new Error("HTTP session create failed")
      const parent = parentResponse.data
      const assign = await sdk.providerAccounts.session.assign({
        sessionID: parent.id,
        providerID: "openai",
        accountID: a.id,
        directory: dir,
      })
      expect(assign.data?.providers.openai).toMatchObject({ mode: "profile", profileID: a.id })
      await AppRuntime.runPromise(profiles.selectDefault("openai", "chatgpt-oauth", b.id))

      const childResponse = await sdk.session.create({ directory: dir, parentID: parent.id })
      if (!childResponse.data) throw new Error("HTTP child create failed")
      const child = childResponse.data
      const forkResponse = await sdk.session.fork({ sessionID: parent.id, directory: dir })
      if (!forkResponse.data) throw new Error("HTTP session fork failed")
      const fork = forkResponse.data
      await AppRuntime.runPromise(profiles.rename(a.id, "surface-A-renamed"))
      const cred = await AppRuntime.runPromise(profiles.credential(a.id))
      if (!cred) throw new Error("persisted profile credential is missing")
      await AppRuntime.runPromise(
        profiles.compareAndSwapCredential({
          id: a.id,
          revision: cred.revision,
          value: secret("surface-A-refreshed"),
        }),
      )
      await AppRuntime.runPromise(profiles.remove(b.id))

      const forged = {
        kilocode: {
          providerBindings: {
            version: 1,
            providers: { openai: { mode: "profile", profileID: "client-forged" } },
          },
          display: { exportProbe: true },
        },
      }
      const offEvent = await AppRuntime.runPromise(
        EventV2.Service.use((service) => service.listen((event) => Effect.sync(() => events.push(event)))),
      )
      const updated = await sdk.session.update({ sessionID: parent.id, directory: dir, metadata: forged })
      await AppRuntime.runPromise(offEvent)
      expect(updated.data?.metadata?.kilocode).toMatchObject({ display: { exportProbe: true } })

      const wire = await Promise.all([
        sdk.session.get({ sessionID: parent.id, directory: dir }),
        sdk.session.get({ sessionID: child.id, directory: dir }),
        sdk.session.get({ sessionID: fork.id, directory: dir }),
        sdk.session.messages({ sessionID: parent.id, directory: dir }),
      ])
      const replay = await AppRuntime.runPromise(
        EventV2.Service.use((service) =>
          service.durable({ aggregateID: parent.id }).pipe(
            Stream.filter((event) => event.type === Session.Event.Updated.type),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      )
      const serialized = JSON.stringify({ wire, events, replay: Array.from(replay) })
      for (const marker of markers) {
        expect(serialized).not.toContain(marker.access)
        expect(serialized).not.toContain(marker.refresh)
      }
      expect(events.length).toBeGreaterThan(0)
      expect(JSON.stringify(events)).toContain(Session.Event.Updated.type)
      expect(JSON.stringify(events)).toContain(parent.id)
      expect(JSON.stringify(replay)).toContain(Session.Event.Updated.type)
      expect(JSON.stringify(replay)).toContain(a.id)
      expect(JSON.stringify(wire[0].data?.metadata)).toContain('"exportProbe":true')
      expect(JSON.stringify(wire[0].data?.metadata)).toContain(a.id)
      expect(JSON.stringify(wire[0].data?.metadata)).not.toContain("client-forged")
      expect(JSON.stringify(wire[1].data?.metadata)).toContain(a.id)
      expect(JSON.stringify(wire[2].data?.metadata)).toContain(a.id)
      expect(wire[3].data).toEqual([])

      process.chdir(dir)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        outputs.push(String(chunk))
        return true
      }) as typeof process.stdout.write
      const handler = ExportCommand.handler
      if (!handler) throw new Error("session export command handler is missing")
      await handler({ sessionID: parent.id, sanitize: true } as never)
      const exported = outputs.join("")
      for (const marker of markers) {
        expect(exported).not.toContain(marker.access)
        expect(exported).not.toContain(marker.refresh)
      }
      expect(JSON.parse(exported).messages).toEqual([])
    } finally {
      process.stdout.write = write
      process.chdir(cwd)
      await server.stop(true)
      await AppRuntime.runPromise(profiles.remove(a.id))
      await AppRuntime.runPromise(profiles.remove(b.id))
      if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
    }
  })

  test("traces hostile provider errors through real session HTTP, messages, events, replay, and export", async () => {
    const priorEnv = process.env.OPENAI_API_KEY
    const priorFlag = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    process.env.OPENAI_API_KEY = "SECRET_ENV_KEY"
    const raw = [
      "SECRET_ACCESS_A",
      "SECRET_REFRESH_A",
      "SECRET_PROVIDER_ERROR",
      "SECRET_ENV_KEY",
      "SECRET_AUTH_CONTENT",
    ].join(" ")
    const userText = "preserve user content: SECRET_AUTH_CONTENT"
    const body = { error: { message: raw, code: raw } }
    const upstream: string[] = []
    const fetch = globalThis.fetch
    const access = "SECRET_ACCESS_A"
    const refresh = "SECRET_REFRESH_A"
    const envKey = "SECRET_ENV_KEY"
    await using tmp = await tmpdir({
      git: true,
      config: {
        formatter: false,
        lsp: false,
        provider: {
          openai: {
            id: "openai",
            name: "OpenAI Test",
            npm: "@ai-sdk/openai",
            env: ["OPENAI_API_KEY"],
            models: {
              "gpt-5-mini": {
                id: "gpt-5-mini",
                name: "GPT-5 mini test",
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
            options: {},
          },
        },
      },
    })
    const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
    const account = await AppRuntime.runPromise(
      profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "hostile-error",
        remoteID: "hostile-error-account",
        credential: { access, refresh, expires: Date.now() + 60_000, accountID: "hostile-error-account" },
      }),
    )
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        if (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com") {
          const headers = new Headers(input instanceof Request ? input.headers : undefined)
          if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
          upstream.push(headers.get("authorization") ?? "")
          return Response.json(body, { status: 401 })
        }
        return fetch(input, init)
      },
      { preconnect: fetch.preconnect },
    )
    const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const sdk = createKiloClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })
    const events: unknown[] = []
    const telemetry: Array<{ event: string; properties: Record<string, unknown> | undefined }> = []
    const capture = spyOn(Client, "capture").mockImplementation((event, properties) => {
      telemetry.push({ event, properties })
    })
    const outputs: string[] = []
    const write = process.stdout.write
    const cwd = process.cwd()
    try {
      const created = await sdk.session.create({ directory: tmp.path, title: "hostile provider error" })
      if (!created.data) throw new Error("HTTP session create failed")
      const off = await AppRuntime.runPromise(
        EventV2.Service.use((service) => service.listen((event) => Effect.sync(() => events.push(event)))),
      )
      const prompt = await sdk.session.prompt({
        sessionID: created.data.id,
        directory: tmp.path,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5-mini" },
        parts: [{ type: "text", text: userText }],
      })
      await AppRuntime.runPromise(off)
      process.stdout.write = write
      const wire = await Promise.all([
        sdk.session.get({ sessionID: created.data.id, directory: tmp.path }),
        sdk.session.messages({ sessionID: created.data.id, directory: tmp.path }),
      ])
      const replay = await AppRuntime.runPromise(
        EventV2.Service.use((service) =>
          service.durable({ aggregateID: created.data!.id }).pipe(
            Stream.filter((event) => event.type === Session.Event.Updated.type),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      )
      process.chdir(tmp.path)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        outputs.push(String(chunk))
        return true
      }) as typeof process.stdout.write
      const handler = ExportCommand.handler
      if (!handler) throw new Error("session export command handler is missing")
      await handler({ sessionID: created.data.id, sanitize: true } as never)
      const exported = outputs.join("")
      const observed = JSON.stringify({ prompt, wire, events, replay: Array.from(replay), exported })
      const promptData = prompt.data as { info?: { error?: unknown }; parts?: unknown[] } | undefined
      const messages = wire[1].data as
        | Array<{ info?: { role?: string; error?: unknown }; parts?: unknown[] }>
        | undefined
      const assistant = messages?.find((message) => message.info?.role === "assistant")
      const user = messages?.find((message) => message.info?.role === "user")

      if (prompt.response?.status !== 200) {
        const listed = await sdk.provider.list({ directory: tmp.path })
        throw new Error(
          JSON.stringify({
            prompt,
            model: listed.data?.all.find((item) => item.id === "openai")?.models["gpt-5-mini"],
            upstream,
          }),
        )
      }
      expect(upstream).toContain(`Bearer ${access}`)
      expect(JSON.stringify(user?.parts)).toContain(userText)
      expect(JSON.stringify(assistant?.info?.error)).not.toContain(access)
      expect(JSON.stringify(assistant?.info?.error)).not.toContain(refresh)
      expect(JSON.stringify(assistant?.info?.error)).not.toContain(envKey)
      expect(JSON.stringify(assistant?.info?.error)).not.toContain("SECRET_PROVIDER_ERROR")
      expect(assistant?.info?.error).toMatchObject({ data: { statusCode: 401, isRetryable: false } })
      expect(JSON.stringify(assistant?.info?.error)).toContain("selected provider account request failed")
      expect(assistant?.parts).toEqual([])
      expect(JSON.stringify(promptData?.info?.error)).not.toContain(access)
      expect(JSON.stringify(promptData?.info?.error)).not.toContain(refresh)
      expect(JSON.stringify(promptData?.info?.error)).not.toContain(envKey)
      expect(JSON.stringify(promptData?.info?.error)).not.toContain("SECRET_PROVIDER_ERROR")
      expect(promptData?.parts).toEqual([])
      expect(JSON.stringify(wire[0].data)).not.toContain(access)
      expect(JSON.stringify(wire[0].data)).not.toContain(refresh)
      expect(JSON.stringify(wire[0].data)).not.toContain(envKey)
      expect(JSON.stringify(wire[1].data)).not.toContain(access)
      expect(JSON.stringify(wire[1].data)).not.toContain(refresh)
      expect(JSON.stringify(wire[1].data)).not.toContain(envKey)
      expect(JSON.stringify(events)).not.toContain(access)
      expect(JSON.stringify(events)).not.toContain(refresh)
      expect(JSON.stringify(events)).not.toContain(envKey)
      expect(JSON.stringify(events)).not.toContain("SECRET_PROVIDER_ERROR")
      expect(JSON.stringify(replay)).toContain(Session.Event.Updated.type)
      expect(JSON.stringify(replay)).not.toContain(access)
      expect(JSON.stringify(replay)).not.toContain(refresh)
      expect(JSON.stringify(replay)).not.toContain(envKey)
      expect(exported).not.toContain(access)
      expect(exported).not.toContain(refresh)
      expect(exported).not.toContain(envKey)
      expect(exported).not.toContain("SECRET_PROVIDER_ERROR")
      expect(observed).not.toContain(access)
      expect(observed).not.toContain(refresh)
      expect(observed).not.toContain(envKey)
      expect(observed).not.toContain("SECRET_PROVIDER_ERROR")
      expect(observed).toContain("SECRET_AUTH_CONTENT")
      expect(telemetry.filter((item) => item.event === TelemetryEvent.LLM_COMPLETION)).toEqual([])
      for (const marker of [access, refresh, envKey, "SECRET_PROVIDER_ERROR", "SECRET_AUTH_CONTENT"]) {
        expect(JSON.stringify(telemetry)).not.toContain(marker)
      }
    } finally {
      capture.mockRestore()
      process.stdout.write = write
      process.chdir(cwd)
      await server.stop(true)
      globalThis.fetch = fetch
      await AppRuntime.runPromise(profiles.remove(account.id))
      if (priorEnv == null) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = priorEnv
      if (priorFlag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = priorFlag
    }
  })
})
