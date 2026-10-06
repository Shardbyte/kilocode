import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Log from "@opencode-ai/core/util/log"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderUsage } from "@opencode-ai/core/kilocode/provider-usage"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { randomUUID } from "crypto"
import os from "os"
import path from "path"
import * as AccountUsage from "@/kilocode/provider/account-usage"
import { makeProviderAccountsHandlers } from "@/kilocode/server/httpapi/handlers/provider-accounts"
import { ProviderAccountsApi } from "@/kilocode/server/httpapi/groups/provider-accounts"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { Session } from "@/session/session"
import { testEffect } from "../../lib/effect"

const TEST_DB = path.join(os.tmpdir(), `usage-security-api-${randomUUID()}.db`)
const Api = HttpApi.make("opencode-instance").addHttpApi(ProviderAccountsApi)
const markers = {
  access: "SECRET_ACCESS_A",
  refresh: "SECRET_REFRESH_A",
  error: "SECRET_PROVIDER_ERROR",
  env: "SECRET_ENV_KEY",
  auth: "SECRET_AUTH_CONTENT",
}
const poison = Object.values(markers).join(" ")
let failure: "dispatch" | "refresh" | "usage" = "usage"
let calls = 0
const logs: string[] = []
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
const transport = Layer.succeed(ProviderUsage.Transport, {
  fetch: Object.assign(
    async (input: RequestInfo | URL) => {
      calls++
      if (String(input) === "https://auth.openai.com/oauth/token") {
        if (failure === "refresh") throw new Error(poison)
        return Response.json({
          access_token: markers.access,
          refresh_token: markers.refresh,
          expires_in: 3600,
        })
      }
      if (failure === "dispatch") throw new Error(poison)
      return Response.json({ error: poison }, { status: 503 })
    },
    { preconnect: fetch.preconnect },
  ),
  plans: async () => {
    throw new Error("Profile usage must not query legacy plans")
  },
  byok: async () => {
    throw new Error("Profile usage must not query legacy BYOK")
  },
  usage: async () => {
    throw new Error("Profile usage must not query legacy usage")
  },
})
const db = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, AccountUsage.node, Database.node]), [
  [Database.node, Database.layerFromPath(TEST_DB).pipe(Layer.fresh)],
  [ProviderUsage.transportNode, transport],
])
const routes = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(
      makeProviderAccountsHandlers({
        start: async () => ({ operationID: "unused", url: "https://auth.invalid", instructions: "unused" }),
        complete: async () => {
          throw new Error("unused")
        },
        cancel: async () => {},
      }),
    ),
    Layer.provide(schemaErrorLayer),
    Layer.provide([passAuthorization, passInstance, passWorkspace, Layer.mock(Session.Service)({})]),
    Layer.provideMerge(db),
  ),
  { disableListenLog: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
const it = testEffect(routes)

it.live("usage HTTP failure has a static DTO and leaves stored auth health unchanged", () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      const env = process.env.SECRET_ENV_KEY
      const auth = process.env.KILO_AUTH_CONTENT
      const hasAuth = Object.hasOwn(process.env, "KILO_AUTH_CONTENT")
      const stderr = process.stderr.write
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      process.env.SECRET_ENV_KEY = markers.env
      process.env.KILO_AUTH_CONTENT = markers.auth
      await Log.init({ print: true, level: "DEBUG" })
      logs.length = 0
      process.stderr.write = ((chunk: string | Uint8Array) => {
        logs.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      Log.create({ service: "qualification" }).debug("logger capture active")
      calls = 0
      return { prior, env, auth, hasAuth, stderr }
    }),
    () =>
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const cases = [
          { failure: "dispatch" as const, expires: Date.now() + 60_000 },
          { failure: "refresh" as const, expires: 0 },
          { failure: "usage" as const, expires: Date.now() + 60_000 },
        ]
        for (const item of cases) {
          failure = item.failure
          const account = yield* profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: `HTTP usage safety ${item.failure}`,
            remoteID: `synthetic-remote-identity-${item.failure}`,
            credential: {
              access: markers.access,
              refresh: markers.refresh,
              expires: item.expires,
              accountID: `synthetic-remote-identity-${item.failure}`,
            },
          })
          const original = yield* profiles.credential(account.id)
          const usage = yield* HttpClient.get(`/provider-accounts/${account.id}/usage`)
          expect(usage.status).toBe(200)
          const body = (yield* usage.json) as {
            accountID: string
            snapshot: { fetchState: string; error?: { code: string; message: string; retryable: boolean } }
          }
          expect(body.accountID).toBe(account.id)
          expect(body.snapshot.fetchState).toBe("unavailable")
          const auth = yield* HttpClient.get(`/provider-accounts/${account.id}/auth-state`)
          expect(yield* auth.json).toMatchObject({
            accountID: account.id,
            state: item.failure === "refresh" ? "expired" : "ready",
            revision: 0,
          })
          expect(yield* profiles.credential(account.id)).toEqual(original)
          expect(JSON.stringify(body)).not.toContain("SECRET_")
        }
        expect(calls).toBe(3)
        const captured = logs.join("\n")
        expect(captured).toContain("logger capture active")
        for (const value of Object.values(markers)) expect(captured).not.toContain(value)
      }),
    (state) =>
      Effect.sync(() => {
        process.stderr.write = state.stderr
        if (state.prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.prior
        if (state.env === undefined) delete process.env.SECRET_ENV_KEY
        else process.env.SECRET_ENV_KEY = state.env
        if (state.hasAuth) process.env.KILO_AUTH_CONTENT = state.auth ?? ""
        else delete process.env.KILO_AUTH_CONTENT
      }),
  ),
)
