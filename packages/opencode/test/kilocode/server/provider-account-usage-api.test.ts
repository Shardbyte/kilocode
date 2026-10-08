import { lifecycle } from "./provider-auth-fixture"
import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderUsage } from "@opencode-ai/core/kilocode/provider-usage"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
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

const TEST_DB = path.join(os.tmpdir(), `provider-account-usage-${randomUUID()}.db`)
const Api = HttpApi.make("opencode-instance").addHttpApi(ProviderAccountsApi)
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
const session = Layer.mock(Session.Service)({})

const requests: Array<{ authorization: string | null; account: string | null }> = []
let reject = false
const fetcher: typeof fetch = Object.assign(
  async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    requests.push({ authorization: headers.get("authorization"), account: headers.get("chatgpt-account-id") })
    const account = headers.get("chatgpt-account-id")
    if (reject && account === "remote-a") {
      reject = false
      return Response.json({ error: "usage-secret-error-payload" }, { status: 401 })
    }
    const used = account === "remote-a" ? 21 : 73
    return Response.json({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } },
    })
  },
  { preconnect: fetch.preconnect },
)
const transport = Layer.succeed(ProviderUsage.Transport, {
  fetch: fetcher,
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
    Layer.provideMerge(lifecycle),
    Layer.provide([passAuthorization, passInstance, passWorkspace, session]),
    Layer.provideMerge(db),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
const it = testEffect(routes)
type Usage = {
  accountID: string
  providerID: string
  authMode: string
  generation: number
  retrievedAt: string
  snapshot: {
    id: string
    fetchState: string
    providerID: string
    sourceKind: string
    windows: Array<Record<string, unknown>>
    error?: { code: string }
  }
}

function json(method: "POST", url: string) {
  return HttpClient.execute(HttpClientRequest.make(method)(url))
}

function profile(tag: string, remote: string) {
  return Effect.gen(function* () {
    const profiles = yield* ProviderAccountProfiles.Service
    return yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: tag,
      remoteID: remote,
      credential: {
        access: `usage-test-access-${tag}`,
        refresh: `usage-test-refresh-${tag}`,
        expires: Date.now() + 3_600_000,
        accountID: remote,
      },
    })
  })
}

it.live("provider account usage is scoped, force-refreshable, and credential-safe", () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      requests.length = 0
      reject = false
      return prior
    }),
    (prior) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
      }),
  ).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const a = yield* profile("Work", "remote-a")
        const b = yield* profile("Personal", "remote-b")
        const get = (id: string) => HttpClient.get(`/provider-accounts/${id}/usage`)
        const first = yield* get(a.id)
        expect(first.status).toBe(200)
        const ua = (yield* first.json) as unknown as Usage
        expect(ua).toMatchObject({ accountID: a.id, providerID: "openai", authMode: "chatgpt-oauth", generation: 1 })
        expect(ua.retrievedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/)
        expect(ua.snapshot.id).toBe(`codex-chatgpt:${a.id}`)
        expect(ua.snapshot).toMatchObject({ fetchState: "ready", providerID: "openai", sourceKind: "direct" })
        expect(ua.snapshot.windows[0]).toMatchObject({ resource: "Codex", unit: "percent", used: 21, limit: 100 })
        const firstB = yield* get(b.id)
        const ub = (yield* firstB.json) as unknown as Usage
        expect(ub).toMatchObject({ accountID: b.id, generation: 1 })
        expect(ub.snapshot.windows[0]).toMatchObject({ used: 73 })

        const cached = yield* get(a.id)
        const cacheBody = (yield* cached.json) as unknown as Usage
        expect(cacheBody.generation).toBe(ua.generation)
        expect(requests).toHaveLength(2)
        expect(requests).toEqual([
          { authorization: "Bearer usage-test-access-Work", account: "remote-a" },
          { authorization: "Bearer usage-test-access-Personal", account: "remote-b" },
        ])

        const refresh = yield* json("POST", `/provider-accounts/${a.id}/usage/refresh`)
        expect(refresh.status).toBe(200)
        const refreshed = (yield* refresh.json) as unknown as Usage
        expect(refreshed.generation).toBe(ua.generation + 1)
        expect(refreshed.accountID).toBe(a.id)
        expect(requests).toHaveLength(3)
        const stillCached = yield* get(b.id)
        expect(((yield* stillCached.json) as unknown as Usage).generation).toBe(ub.generation)

        const serialized = JSON.stringify([ua, ub, refreshed])
        expect(serialized).not.toContain("usage-test-access")
        expect(serialized).not.toContain("usage-test-refresh")
        expect(serialized).not.toContain("remote-a")
        expect(serialized).not.toContain("remote-b")
        expect(serialized).not.toMatch(/token|secret/i)

        reject = true
        const failed = yield* json("POST", `/provider-accounts/${a.id}/usage/refresh`)
        const failure = (yield* failed.json) as unknown as Usage
        expect(failure).toMatchObject({
          accountID: a.id,
          snapshot: { fetchState: "unavailable", error: { code: "codex_auth_unavailable" } },
        })
        expect(JSON.stringify(failure)).not.toContain("usage-secret-error-payload")
        expect(failure.generation).toBe(refreshed.generation + 1)

        const missing = yield* get("missing-account")
        expect(missing.status).toBe(200)
        expect(yield* missing.json).toMatchObject({
          accountID: "missing-account",
          providerID: "openai",
          authMode: "chatgpt-oauth",
          generation: 1,
          snapshot: { fetchState: "unavailable", windows: [], error: { code: expect.any(String) } },
        })
        const profiles = yield* ProviderAccountProfiles.Service
        yield* profiles.remove(a.id)
        const deleted = yield* get(a.id)
        expect(yield* deleted.json).toMatchObject({
          accountID: a.id,
          snapshot: { fetchState: "unavailable", windows: [] },
        })
        expect(requests).toHaveLength(4)
      }),
    ),
  ),
)

it.live("provider account usage routes remain behind the profile feature guard", () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      return prior
    }),
    (prior) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
      }),
  ).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/provider-accounts/missing/usage")
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject({
          error: "Disabled",
          message: "Provider profiles are disabled",
        })
      }),
    ),
  ),
)
