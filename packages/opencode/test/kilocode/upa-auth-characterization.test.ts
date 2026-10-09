import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { Auth } from "@/auth"
import { Session } from "@/session/session"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { resolveBinding } from "@/kilocode/provider/codex-profile"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Auth.node,
      ProviderAccountProfiles.node,
      SessionBinding.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Database.node,
    ]),
  ),
)

const discovery = testEffect(
  AppNodeBuilder.build(LayerNode.group([Provider.node, Auth.node, ProviderAccountProfiles.node]), [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ enabled_providers: ["openai"] }) })],
  ]),
)

const completion = testEffect(
  AppNodeBuilder.build(LayerNode.group([ProviderAuth.node, Auth.node, ProviderAccountProfiles.node]), [
    [
      Plugin.node,
      Layer.mock(Plugin.Service)({ list: () => Effect.promise(async () => [await CodexAuthPlugin({} as never)]) }),
    ],
  ]),
)

completion.instance("UPA-0 legacy device callback writes Auth without creating or mirroring a profile", () =>
  Effect.gen(function* () {
    const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    const original = globalThis.fetch
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const calls: string[] = []
    const jwt = `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: "fixture-device" })).toString("base64url")}.sig`
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        calls.push(url)
        if (url.endsWith("/deviceauth/usercode"))
          return Response.json({ device_auth_id: "fixture-device", user_code: "fixture-code", interval: "1" })
        if (url.endsWith("/deviceauth/token"))
          return Response.json({ authorization_code: "fixture-code", code_verifier: "fixture-verifier" })
        if (url === "https://auth.openai.com/oauth/token")
          return Response.json({
            id_token: jwt,
            access_token: "fixture-device-access",
            refresh_token: "fixture-device-refresh",
            expires_in: 60,
          })
        throw new Error("Unexpected OAuth fixture request")
      },
      { preconnect: original.preconnect },
    )
    const auth = yield* Auth.Service
    yield* Effect.addFinalizer(() =>
      auth.remove("openai").pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.sync(() => {
            globalThis.fetch = original
            if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
            else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
          }),
        ),
      ),
    )
    const profiles = yield* ProviderAccountProfiles.Service
    const before = yield* profiles.list("openai", "chatgpt-oauth")
    const service = yield* ProviderAuth.Service
    const started = yield* service.authorize({ providerID: ProviderV2.ID.openai, method: 1 })
    expect(started?.url).toBe("https://auth.openai.com/codex/device")
    yield* service.callback({ providerID: ProviderV2.ID.openai, method: 1 })
    expect(yield* auth.get("openai")).toMatchObject({
      type: "oauth",
      access: "fixture-device-access",
      accountId: "fixture-device",
    })
    expect(yield* profiles.list("openai", "chatgpt-oauth")).toEqual(before)
    expect(calls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ])
  }),
)

for (const mode of ["api", "oauth", "profile"] as const)
  discovery.instance(`UPA-0 mixed discovery preserves ${mode} provider source with a profile present`, () =>
    Effect.gen(function* () {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      const auth = yield* Auth.Service
      const profiles = yield* ProviderAccountProfiles.Service
      yield* Effect.addFinalizer(() =>
        auth.remove("openai").pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.sync(() => {
              if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
              else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
            }),
          ),
        ),
      )
      yield* auth.remove("openai")
      const account = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: `upa-discovery-${mode}`,
        remoteID: `upa-${mode}`,
        credential: {
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: 1_900_000_000_000,
          accountID: `upa-${mode}`,
        },
      })
      yield* Effect.addFinalizer(() => profiles.remove(account.id).pipe(Effect.orDie))
      if (mode === "api") yield* auth.set("openai", { type: "api", key: "fixture-key" })
      if (mode === "oauth")
        yield* auth.set("openai", {
          type: "oauth",
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: 1_900_000_000_000,
        })
      const provider = yield* Provider.Service
      const all = yield* provider.list()
      expect(all[ProviderV2.ID.openai]?.source).toBe(mode === "oauth" ? "custom" : mode)
      expect(Object.keys(all[ProviderV2.ID.openai]?.models ?? {}).length).toBeGreaterThan(0)
      expect((yield* profiles.credential(account.id))?.revision).toBe(0)
    }),
  )

it.instance("UPA-0 persisted legacy authority still dispatches the replacement provider-wide OAuth source", () =>
  Effect.gen(function* () {
    const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    const original = globalThis.fetch
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers).get("authorization") ?? "")
        return Response.json({ fixture: true })
      },
      { preconnect: original.preconnect },
    )
    const auth = yield* Auth.Service
    yield* Effect.addFinalizer(() =>
      auth.remove("openai").pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.sync(() => {
            globalThis.fetch = original
            if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
            else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
          }),
        ),
      ),
    )
    const value = (tag: string) => ({
      type: "oauth" as const,
      access: `fixture-${tag}`,
      refresh: `fixture-refresh-${tag}`,
      expires: Date.now() + 60_000,
      accountId: tag,
    })
    yield* auth.set("openai", value("a"))
    const sessions = yield* Session.Service
    const chat = yield* sessions.create()
    const binding = yield* sessions.binding(chat.id)
    expect(binding?.providers.openai).toMatchObject({ mode: "legacy" })
    const hooks = yield* Effect.promise(() => CodexAuthPlugin({} as never))
    const loaded = yield* Effect.promise(() =>
      hooks.auth!.loader!(() => Effect.runPromise(auth.get("openai")).then((value) => value!), {} as never),
    )
    const request = loaded.fetch as typeof fetch
    yield* Effect.promise(() => request("https://api.openai.com/v1/responses"))
    yield* auth.set("openai", value("b"))
    expect(resolveBinding(binding?.providers.openai, false)).toEqual({ mode: "legacy" })
    yield* Effect.promise(() => request("https://api.openai.com/v1/responses"))
    expect(calls).toEqual(["Bearer fixture-a", "Bearer fixture-b"])
    expect(yield* sessions.binding(chat.id)).toEqual(binding)
  }),
)

test("UPA-0 model policy uses legacy OAuth context, leaving profile-only and API-key metadata unchanged", async () => {
  const hooks = await CodexAuthPlugin({} as never)
  const policy = hooks.provider!.models!
  const models = Object.fromEntries(
    ["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-6-luna", "gpt-5.5-pro", "other-model", "gpt-6-pro"].map((id) => [
      id,
      {
        id,
        api: { id },
        options: id === "gpt-6-pro" ? { reasoningMode: "pro" } : {},
        cost: { input: 2, output: 3, cache: { read: 1, write: 1 } },
        limit: { context: 123, input: 100, output: 23 },
      },
    ]),
  )
  const provider = { id: "openai", models }
  const profile = await policy(provider as never, {} as never)
  const key = await policy(provider as never, { auth: { type: "api", key: "fixture-key" } } as never)
  const oauth = await policy(provider as never, { auth: { type: "oauth" } } as never)
  expect(Object.is(profile, models)).toBe(true)
  expect(Object.is(key, models)).toBe(true)
  expect(Object.keys(oauth)).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-6-luna"])
  expect(oauth["gpt-5.5"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
  expect(oauth["gpt-5.6-sol"]?.limit).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
  expect(oauth["gpt-6-luna"]?.limit).toEqual(models["gpt-6-luna"]?.limit)
  for (const model of Object.values(oauth))
    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  expect(models["gpt-5.5"]?.cost.input).toBe(2)
})
