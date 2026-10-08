import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Auth } from "@/auth"
import { Credential } from "@opencode-ai/core/credential"
import { ModelCache } from "@/provider/model-cache"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { InstanceStore } from "@/project/instance-store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config } from "@/config/config"
import { KiloViewers } from "@/kilocode/presence/service"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { TestConfig } from "../../fixture/config"
import { testInstanceStoreLayer } from "../../fixture/fixture"
import { ProviderApi } from "../../../src/server/routes/instance/httpapi/groups/provider"
import { providerHandlers } from "../../../src/server/routes/instance/httpapi/handlers/provider"
import { ControlApi } from "../../../src/server/routes/instance/httpapi/groups/control"
import { controlHandlers } from "../../../src/server/routes/instance/httpapi/handlers/control"
import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import * as AccountUsage from "@/kilocode/provider/account-usage"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { randomUUID } from "crypto"
import os from "os"
import path from "path"
import { makeProviderAccountsHandlers } from "../../../src/kilocode/server/httpapi/handlers/provider-accounts"
import { ProviderAccountsApi } from "../../../src/kilocode/server/httpapi/groups/provider-accounts"
import type { OAuthAdapter } from "../../../src/kilocode/provider-account-oauth"
import { Authorization } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "../../../src/server/routes/instance/httpapi/middleware/schema-error"
import { Session } from "../../../src/session/session"
import { testEffect } from "../../lib/effect"

type OAuthResult = Awaited<ReturnType<typeof import("../../../src/plugin/openai/codex").completeCodexOAuth>>
const TEST_DB = path.join(os.tmpdir(), `provider-accounts-${randomUUID()}.db`)
const Api = HttpApi.make("opencode-instance").addHttpApi(ProviderAccountsApi).addHttpApi(ProviderApi)
const passAuthorization = Layer.succeed(
  Authorization,
  Authorization.of((effect) => effect),
)
const passInstance = instanceContextLayer
const passWorkspace = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() }))),
  ),
)
const session = Layer.mock(Session.Service)({
  assignBinding: () => Effect.fail(new SessionBinding.TurnActiveError({ message: "synthetic-access-private" })),
})
const db = AppNodeBuilder.build(
  LayerNode.group([
    ProviderAccountProfiles.node,
    AccountUsage.node,
    Database.node,
    Provider.node,
    ProviderAuth.node,
    Auth.node,
    Credential.node,
    ModelCache.node,
    Config.node,
    ModelsDev.node,
  ]),
  [
    [
      Config.node,
      TestConfig.layer({ get: () => Effect.succeed({ enabled_providers: ["openai"], formatter: false, lsp: false }) }),
    ],
    [Database.node, Database.layerFromPath(TEST_DB).pipe(Layer.fresh)],
  ],
)

const adapter: OAuthAdapter<OAuthResult> = {
  start: async () => {
    adapterState.count += 1
    const operationID = `synthetic-op-${adapterState.count}`
    return { operationID, url: `https://auth.invalid/${operationID}`, instructions: "Continue in browser" }
  },
  complete: async (operationID) => {
    const result = adapterState.results.get(operationID)
    if (!result) throw new Error("synthetic OAuth result missing")
    return result
  },
  cancel: async () => {},
}

const adapterState = {
  count: 0,
  results: new Map<string, OAuthResult>(),
}

const routes = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide([makeProviderAccountsHandlers(adapter), providerHandlers]),
    Layer.merge(
      HttpApiBuilder.layer(HttpApi.make("opencode-root").addHttpApi(ControlApi)).pipe(Layer.provide(controlHandlers)),
    ),
    Layer.provide(schemaErrorLayer),
    Layer.provide(KiloViewers.defaultLayer),
    Layer.provide([passAuthorization, passInstance, passWorkspace, session]),
    Layer.provideMerge(testInstanceStoreLayer),
    Layer.provideMerge(db),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provide(KiloViewers.defaultLayer),
  Layer.provideMerge(testInstanceStoreLayer),
  Layer.provideMerge(db),
  Layer.provideMerge(NodeHttpServer.layerTest),
)
const it = testEffect(routes)

function json(method: "POST" | "PUT" | "PATCH", url: string, body: unknown) {
  return HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(HttpClient.execute))
}

function result(tag: string, remoteID: string): OAuthResult {
  return {
    credential: {
      access: `synthetic-access-${tag}`,
      refresh: `synthetic-refresh-${tag}`,
      expires: 2_000_000_000_000,
      accountID: remoteID,
    },
    remoteID,
  }
}

function create(tag: string, remoteID: string) {
  return Effect.gen(function* () {
    const start = yield* json("POST", "/provider-accounts/oauth/start", { label: tag })
    const op = (yield* start.json) as { operationID: string }
    adapterState.results.set(op.operationID, result(tag, remoteID))
    const done = yield* json("POST", "/provider-accounts/oauth/complete", { operationID: op.operationID })
    return (yield* done.json) as { account: { id: string; revision: number } }
  })
}

it.live("provider account routes use the real profile store and return credential-free metadata", () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
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
        adapterState.count = 0
        adapterState.results.clear()
        const profiles = yield* ProviderAccountProfiles.Service
        const a = yield* create("Work", "remote-work")
        const b = yield* create("Personal", "remote-personal")
        expect(a.account.revision).toBe(0)
        expect(b.account.revision).toBe(0)
        expect(JSON.stringify([a, b])).not.toContain("synthetic-access")
        expect(JSON.stringify([a, b])).not.toContain("synthetic-refresh")

        const busy = yield* json("PUT", "/session/ses_running/provider-accounts/openai", { accountID: a.account.id })
        expect(busy.status).toBe(400)
        const conflict = yield* busy.json
        expect(conflict).toMatchObject({ error: "Conflict", message: expect.stringContaining("A turn is running") })
        expect(JSON.stringify(conflict)).not.toContain("synthetic-access")

        const listed = yield* HttpClient.get("/provider-accounts?provider=openai")
        const list = (yield* listed.json) as { accounts: Array<{ id: string; label: string; isDefault: boolean }> }
        expect(list.accounts.map(({ label, isDefault }) => ({ label, isDefault }))).toEqual([
          { label: "Work", isDefault: true },
          { label: "Personal", isDefault: false },
        ])
        expect((list as { defaultAccountID?: string }).defaultAccountID).toBe(a.account.id)
        expect(JSON.stringify(list)).not.toContain("synthetic-access")
        expect(JSON.stringify(list)).not.toContain("synthetic-refresh")

        const legacy = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Missing metadata",
          credential: { access: "internal-access", refresh: "internal-refresh", expires: 2_000_000_000_000 },
        })
        const legacyDetails = yield* HttpClient.get(`/provider-accounts/${legacy.id}`)
        const legacyInfo = (yield* legacyDetails.json) as unknown as Record<string, unknown>
        expect(legacyInfo.remoteID).toBeUndefined()
        expect(legacyInfo.revision).toBe(0)
        yield* profiles.remove(legacy.id)

        const duplicateStart = yield* json("POST", "/provider-accounts/oauth/start", { label: "Work copy" })
        const duplicateOp = (yield* duplicateStart.json) as { operationID: string }
        adapterState.results.set(duplicateOp.operationID, result("duplicate", "remote-work"))
        const duplicateDone = yield* json("POST", "/provider-accounts/oauth/complete", {
          operationID: duplicateOp.operationID,
        })
        expect(duplicateDone.status).toBe(400)
        expect(yield* duplicateDone.json).toMatchObject({ error: "Duplicate" })

        const detail = yield* HttpClient.get(`/provider-accounts/${a.account.id}`)
        const account = yield* detail.json
        expect(account as unknown).toMatchObject({
          id: a.account.id,
          label: "Work",
          revision: 0,
          authState: "ready",
        })
        expect(JSON.stringify(account)).not.toContain("synthetic-access")
        const health = yield* HttpClient.get(`/provider-accounts/${a.account.id}/auth-state`)
        expect(yield* health.json).toMatchObject({ accountID: a.account.id, state: "ready", revision: 0 })

        const renamed = yield* json("PATCH", `/provider-accounts/${a.account.id}`, { label: "Work laptop" })
        expect(((yield* renamed.json) as unknown as { label: string }).label).toBe("Work laptop")
        const duplicateRename = yield* json("PATCH", `/provider-accounts/${b.account.id}`, {
          label: "Work laptop",
        })
        expect(duplicateRename.status).toBe(400)
        expect(yield* duplicateRename.json).toMatchObject({ error: "Duplicate" })
        const selected = yield* json("PUT", "/provider-accounts/openai/default", { accountID: b.account.id })
        expect(selected.status).toBe(200)
        expect(yield* profiles.getDefault("openai", "chatgpt-oauth")).toBe(b.account.id)
        const cleared = yield* HttpClientRequest.make("DELETE")("/provider-accounts/openai/default").pipe(
          HttpClient.execute,
        )
        expect(cleared.status).toBe(200)
        expect(yield* profiles.getDefault("openai", "chatgpt-oauth")).toBeUndefined()
        const noDefault = yield* HttpClient.get("/provider-accounts?provider=openai")
        expect((yield* noDefault.json) as unknown as Record<string, unknown>).not.toHaveProperty("defaultAccountID")
        const removed = yield* HttpClientRequest.make("DELETE")(`/provider-accounts/${a.account.id}`).pipe(
          HttpClient.execute,
        )
        expect(removed.status).toBe(200)
        expect(yield* profiles.get(a.account.id)).toBeUndefined()

        const staleStart = yield* json("POST", `/provider-accounts/${b.account.id}/oauth/start`, {
          expectedRevision: 0,
        })
        const staleOp = (yield* staleStart.json) as { operationID: string }
        adapterState.results.set(staleOp.operationID, result("stale", "remote-personal"))
        yield* profiles.reauthenticate({
          id: b.account.id,
          revision: 0,
          remoteID: "remote-personal",
          value: result("newer", "remote-personal").credential,
        })
        const staleDone = yield* json("POST", "/provider-accounts/oauth/complete", {
          operationID: staleOp.operationID,
        })
        expect(staleDone.status).toBe(400)
        expect(yield* staleDone.json).toMatchObject({ error: "Conflict" })
        const replay = yield* json("POST", "/provider-accounts/oauth/complete", {
          operationID: staleOp.operationID,
        })
        expect(yield* replay.json).toMatchObject({ error: "NotFound" })
        expect((yield* profiles.credential(b.account.id))?.value.access).toBe("synthetic-access-newer")

        const wrongStart = yield* json("POST", `/provider-accounts/${b.account.id}/oauth/start`, {
          expectedRevision: 1,
        })
        const wrongOp = (yield* wrongStart.json) as { operationID: string }
        adapterState.results.set(wrongOp.operationID, result("wrong", "remote-other"))
        const wrongDone = yield* json("POST", "/provider-accounts/oauth/complete", {
          operationID: wrongOp.operationID,
        })
        expect(wrongDone.status).toBe(400)
        expect(yield* wrongDone.json).toMatchObject({ error: "IdentityMismatch" })
        expect((yield* profiles.credential(b.account.id))?.value.access).toBe("synthetic-access-newer")

        const deletedStart = yield* json("POST", `/provider-accounts/${b.account.id}/oauth/start`, {
          expectedRevision: 1,
        })
        const deletedOp = (yield* deletedStart.json) as { operationID: string }
        adapterState.results.set(deletedOp.operationID, result("deleted", "remote-personal"))
        yield* profiles.remove(b.account.id)
        const deletedDone = yield* json("POST", "/provider-accounts/oauth/complete", {
          operationID: deletedOp.operationID,
        })
        expect(deletedDone.status).toBe(400)
        expect(yield* deletedDone.json).toMatchObject({ error: "NotFound" })
        expect(yield* profiles.list("openai", "chatgpt-oauth")).toEqual([])

        const unknownCancel = yield* HttpClientRequest.make("DELETE")("/provider-accounts/oauth/unowned-op").pipe(
          HttpClient.execute,
        )
        expect(unknownCancel.status).toBe(400)
        expect(yield* unknownCancel.json).toMatchObject({ error: "NotFound" })
      }),
    ),
  ),
)

it.live("provider availability follows real auth and account lifecycle without selecting credentials", () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      const events: string[] = []
      const listener = (event: GlobalEvent) => {
        if (event.payload.type === "server.instance.disposed") events.push(event.payload.type)
      }
      GlobalBus.on("event", listener)
      return { prior, events, listener }
    }),
    (state) =>
      Effect.sync(() => {
        GlobalBus.off("event", state.listener)
        if (state.prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.prior
      }),
  ).pipe(
    Effect.flatMap((state) =>
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const remove = (id: string) =>
          HttpClientRequest.make("DELETE")(`/provider-accounts/${id}`).pipe(HttpClient.execute)
        const available = (expected: boolean, source?: string) =>
          Effect.gen(function* () {
            const response = yield* HttpClient.get("/provider")
            expect(response.status).toBe(200)
            const body = (yield* response.json) as {
              connected: string[]
              all: Array<{ id: string; source: string; models: Record<string, unknown> }>
            }
            expect(body.connected.includes("openai")).toBe(expected)
            const item = body.all.find((item) => item.id === "openai")
            expect(item).toBeDefined()
            expect(Object.keys(item!.models).length).toBeGreaterThan(0)
            if (source) expect(item?.source).toBe(source)
          })
        const disconnect = () => HttpClientRequest.make("DELETE")("/auth/openai").pipe(HttpClient.execute)
        expect((yield* disconnect()).status).toBe(200)
        yield* available(false)

        // Prime Provider.InstanceState before the first account: this is the clean-state defect.
        const before = state.events.length
        const a = yield* create("Availability Work", "availability-work")
        expect(state.events.length).toBeGreaterThan(before)
        yield* available(true, "profile")
        const provider = yield* Provider.Service
        const store = yield* InstanceStore.Service
        const language = yield* store.provide(
          { directory: process.cwd() },
          provider
            .getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5-mini"))
            .pipe(Effect.flatMap((model) => provider.getLanguage(model, a.account.id))),
        )
        expect(language).toBeDefined()
        const b = yield* create("Availability Personal", "availability-personal")
        yield* available(true, "profile")
        const count = state.events.length
        yield* json("PUT", "/provider-accounts/openai/default", { accountID: b.account.id })
        yield* available(true, "profile")
        yield* json("PATCH", `/provider-accounts/${a.account.id}`, { label: "Availability Renamed" })
        yield* available(true, "profile")
        expect(state.events).toHaveLength(count)

        const start = yield* json("POST", `/provider-accounts/${a.account.id}/oauth/start`, { expectedRevision: 0 })
        const op = (yield* start.json) as { operationID: string }
        adapterState.results.set(op.operationID, result("availability-reauth", "availability-work"))
        const done = yield* json("POST", "/provider-accounts/oauth/complete", { operationID: op.operationID })
        expect(done.status).toBe(200)
        expect(state.events.length).toBeGreaterThan(count)
        yield* available(true, "profile")
        expect(yield* profiles.getDefault("openai", "chatgpt-oauth")).toBe(b.account.id)

        expect((yield* remove(a.account.id)).status).toBe(200)
        yield* available(true, "profile")
        expect((yield* remove(b.account.id)).status).toBe(200)
        yield* available(false)
        expect(yield* profiles.getDefault("openai", "chatgpt-oauth")).toBeUndefined()

        const c = yield* create("Availability Mixed", "availability-mixed")
        expect((yield* json("PUT", "/auth/openai", { type: "api", key: "availability-legacy-key" })).status).toBe(200)
        yield* available(true, "api")
        expect((yield* disconnect()).status).toBe(200)
        yield* available(true, "profile")
        expect((yield* remove(c.account.id)).status).toBe(200)
        yield* available(false)

        expect((yield* json("PUT", "/auth/openai", { type: "api", key: "availability-legacy-only" })).status).toBe(200)
        yield* available(true, "api")
        expect((yield* disconnect()).status).toBe(200)
        yield* available(false)
      }),
    ),
  ),
)
