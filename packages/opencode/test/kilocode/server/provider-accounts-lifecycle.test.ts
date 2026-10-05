import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { expect, test } from "bun:test"
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
import { InstanceContextMiddleware } from "../../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "../../../src/server/routes/instance/httpapi/middleware/schema-error"
import { Session } from "../../../src/session/session"
import { testEffect } from "../../lib/effect"

type OAuthResult = Awaited<ReturnType<typeof import("../../../src/plugin/openai/codex").completeCodexOAuth>>
const TEST_DB = path.join(os.tmpdir(), `provider-accounts-${randomUUID()}.db`)
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
const db = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [
  [Database.node, Database.layerFromPath(TEST_DB).pipe(Layer.fresh)],
])

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
    Layer.provide(makeProviderAccountsHandlers(adapter)),
    Layer.provide(schemaErrorLayer),
    Layer.provide([passAuthorization, passInstance, passWorkspace, session]),
    Layer.provideMerge(db),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
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
