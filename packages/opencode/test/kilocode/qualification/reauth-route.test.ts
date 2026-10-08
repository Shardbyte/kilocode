import { lifecycle } from "../server/provider-auth-fixture"
import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { TestConfig } from "../../fixture/config"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { makeProviderAccountsHandlers } from "@/kilocode/server/httpapi/handlers/provider-accounts"
import { ProviderAccountsApi } from "@/kilocode/server/httpapi/groups/provider-accounts"
import * as AccountUsage from "@/kilocode/provider/account-usage"
import type { OAuthAdapter } from "@/kilocode/provider-account-oauth"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { Effect, Fiber, Layer } from "effect"
import { HttpServer, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { createKiloClient } from "@kilocode/sdk/v2"
import { expect } from "bun:test"
import Http from "node:http"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const model = { providerID: ProviderV2.ID.openai, id: ModelV2.ID.make("gpt-5") }
const config = {
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
type OAuthResult = Awaited<ReturnType<typeof import("@/plugin/openai/codex").completeCodexOAuth>>
const oauth = {
  operation: 0,
  results: new Map<string, OAuthResult>(),
}
const adapter: OAuthAdapter<OAuthResult> = {
  start: async () => {
    const operationID = `reauth-route-${++oauth.operation}`
    return { operationID, url: `https://auth.invalid/${operationID}`, instructions: "synthetic authorization" }
  },
  complete: async (operationID) => {
    const result = oauth.results.get(operationID)
    if (!result) throw new Error("synthetic OAuth result missing")
    return result
  },
}
const passAuthorization = Layer.succeed(
  Authorization,
  Authorization.of((effect) => effect),
)
const passInstance = Layer.succeed(
  InstanceContextMiddleware,
  InstanceContextMiddleware.of((effect) => effect),
)
const passWorkspace = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() }))),
  ),
)
const db = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, AccountUsage.node, Database.node]), [
  [Database.node, Database.layerFromPath(path.join(os.tmpdir(), `reauth-route-${randomUUID()}.db`)).pipe(Layer.fresh)],
])
const Api = HttpApi.make("opencode-instance").addHttpApi(ProviderAccountsApi)
const deps = AppNodeBuilder.build(
  LayerNode.group([
    LLM.node,
    Session.node,
    SessionProjector.node,
    CrossSpawnSpawner.node,
    EventV2Bridge.node,
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
)
const routes = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(makeProviderAccountsHandlers(adapter)),
    Layer.provide(schemaErrorLayer),
    Layer.provideMerge(lifecycle),
    Layer.provide([passAuthorization, passInstance, passWorkspace]),
    Layer.provideMerge(db),
    Layer.provideMerge(deps),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 })))
const it = testEffect(routes)

it.instance("SDK reauthentication route wins a held same-profile OAuth refresh CAS", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = {
        flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
        key: process.env.OPENAI_API_KEY,
        auth: process.env.KILO_AUTH_CONTENT,
        fetch: globalThis.fetch,
      }
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const calls: Array<{ url: string; bearer: string | null; account: string | null }> = []
      let refreshes = 0
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.OPENAI_API_KEY = "REAUTH_ROUTE_ENV_POISON"
      process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "REAUTH_ROUTE_LEGACY_POISON" } })
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
          if (url === "https://auth.openai.com/oauth/token") {
            refreshes++
            entered.resolve()
            return release.promise
          }
          if (!url.startsWith("https://chatgpt.com/backend-api/codex/responses"))
            throw new Error(`unexpected external request: ${url}`)
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          calls.push({ url, bearer: headers.get("authorization"), account: headers.get("chatgpt-account-id") })
          return Response.json({ error: { message: "synthetic response failure" } }, { status: 401 })
        },
        { preconnect: prior.fetch.preconnect },
      )
      return { ...prior, entered, release, calls, refreshes: () => refreshes }
    }),
    (state) =>
      Effect.gen(function* () {
        const dir = yield* TestInstance
        const profiles = yield* ProviderAccountProfiles.Service
        const provider = yield* Provider.Service
        const profile = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "route contention A",
          remoteID: "reauth-route-A",
          credential: {
            access: "REAUTH_ROUTE_OLD_ACCESS",
            refresh: "REAUTH_ROUTE_REFRESH",
            expires: 0,
            accountID: "reauth-route-A",
          },
        })
        const other = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "route contention B",
          remoteID: "reauth-route-B",
          credential: {
            access: "REAUTH_ROUTE_B_ACCESS",
            refresh: "REAUTH_ROUTE_B_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "reauth-route-B",
          },
        })
        yield* profiles.selectDefault("openai", "chatgpt-oauth", other.id)
        const endpoint = yield* HttpServer.HttpServer.use((server) =>
          Effect.succeed(HttpServer.formatAddress(server.address)),
        )
        const native = state.fetch
        const sdk = createKiloClient({ baseUrl: endpoint, fetch: native })
        const item = yield* provider.getModel(model.providerID, model.id)
        const language = yield* provider.getLanguage(item, profile.id)
        const request = Effect.tryPromise(() =>
          language.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "expired profile refresh" }] }],
          }),
        )
        const pending = yield* request.pipe(Effect.exit, Effect.forkChild)
        yield* Effect.promise(() => state.entered.promise)
        expect(state.refreshes()).toBe(1)

        const started = yield* Effect.tryPromise(() =>
          sdk.providerAccounts.oauth.reauthenticate({
            accountID: profile.id,
            expectedRevision: 0,
            directory: dir.directory,
          }),
        )
        expect(started.error).toBeUndefined()
        if (!started.data) throw new Error(`reauth route start failed: ${JSON.stringify(started.error)}`)
        expect(started.data.url).toMatch(/^https:\/\/auth\.invalid\//)
        expect(started.data.instructions).toBe("synthetic authorization")
        oauth.results.set(started.data.operationID, {
          credential: {
            access: "REAUTH_ROUTE_AUTHORIZED_ACCESS",
            refresh: "REAUTH_ROUTE_AUTHORIZED_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "reauth-route-A",
          },
          remoteID: "reauth-route-A",
        })
        const completed = yield* Effect.tryPromise(() =>
          sdk.providerAccounts.oauth.complete({ operationID: started.data!.operationID, directory: dir.directory }),
        )
        expect(completed.error).toBeUndefined()
        expect(completed.data?.account).toMatchObject({
          id: profile.id,
          revision: 1,
          remoteID: "reauth-route-A",
          authState: "ready",
        })
        expect(JSON.stringify(completed.data)).not.toContain("REAUTH_ROUTE_AUTHORIZED")

        state.release.resolve(
          Response.json({
            access_token: "REAUTH_ROUTE_STALE_REFRESH_ACCESS",
            refresh_token: "REAUTH_ROUTE_STALE_REFRESH_TOKEN",
            expires_in: 3600,
          }),
        )
        const result = yield* Fiber.join(pending)
        expect(result._tag).toBe("Failure")
        expect(state.refreshes()).toBe(1)
        expect(state.calls).toHaveLength(0)
        expect(yield* profiles.credential(profile.id)).toMatchObject({
          revision: 1,
          value: { access: "REAUTH_ROUTE_AUTHORIZED_ACCESS", refresh: "REAUTH_ROUTE_AUTHORIZED_REFRESH" },
        })
        const current = yield* profiles.credential(profile.id)
        expect(current?.value.access).not.toContain("STALE")
        yield* Effect.exit(
          Effect.tryPromise(() =>
            language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "reauthenticated A" }] }] }),
          ),
        )
        expect(state.calls).toEqual([
          {
            url: "https://chatgpt.com/backend-api/codex/responses",
            bearer: "Bearer REAUTH_ROUTE_AUTHORIZED_ACCESS",
            account: "reauth-route-A",
          },
        ])
        expect(JSON.stringify(state.calls)).not.toContain("REAUTH_ROUTE_B")
        expect(JSON.stringify(state.calls)).not.toContain("POISON")
      }),
    (state) =>
      Effect.sync(() => {
        state.release.resolve(Response.json({ access_token: "cleanup", refresh_token: "cleanup", expires_in: 1 }))
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
