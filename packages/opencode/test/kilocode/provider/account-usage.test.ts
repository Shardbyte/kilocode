import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderUsage } from "@opencode-ai/core/kilocode/provider-usage"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as AccountUsage from "../../../src/kilocode/provider/account-usage"
import { refresh } from "../../../src/kilocode/provider/codex-profile"
import { testEffect } from "../../lib/effect"

const transport = ProviderUsage.Transport.of({
  fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => request(input, init), {
    preconnect: fetch.preconnect,
  }),
  plans: async () => {
    throw new Error("Legacy plans must not resolve profile usage")
  },
  byok: async () => {
    throw new Error("Legacy BYOK must not resolve profile usage")
  },
  usage: async () => {
    throw new Error("Legacy usage must not resolve profile usage")
  },
})
const env = LayerNode.compile(LayerNode.group([AccountUsage.node, ProviderAccountProfiles.node]), [
  [ProviderUsage.transportNode, Layer.succeed(ProviderUsage.Transport, transport)],
])
const it = testEffect(env)
const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
let request: typeof fetch = Object.assign(
  async () => Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25 } } }),
  { preconnect: fetch.preconnect },
)

beforeEach(() => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
})

afterEach(() => {
  if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
  request = Object.assign(
    async () => Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25 } } }),
    { preconnect: fetch.preconnect },
  )
})

const create = Effect.fn("AccountUsageTest.create")(function* (label: string, access: string) {
  const profiles = yield* ProviderAccountProfiles.Service
  return yield* profiles.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label,
    remoteID: `remote-${label}`,
    credential: { access, refresh: `refresh-${label}`, expires: Date.now() + 60_000, accountID: `remote-${label}` },
  })
})

describe("account-authoritative provider usage", () => {
  it.instance("rejects another provider before accessing the OpenAI refresh transport", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const account = yield* profiles.create({
        provider: "other-provider",
        authMode: "chatgpt-oauth",
        label: "wrong-provider",
        credential: { access: "FOREIGN_ACCESS_SENTINEL", refresh: "FOREIGN_REFRESH_SENTINEL", expires: 0 },
      })
      let calls = 0
      request = Object.assign(
        async () => {
          calls++
          return Response.json({ access_token: "invalid", refresh_token: "invalid", expires_in: 3600 })
        },
        { preconnect: fetch.preconnect },
      )
      const original = yield* profiles.credential(account.id)
      const value = yield* usage.get(account.id)
      expect(value.snapshot.fetchState).toBe("unavailable")
      const rejected = yield* Effect.exit(Effect.tryPromise(() => refresh(account.id, profiles, request)))
      expect(rejected._tag).toBe("Failure")
      expect(calls).toBe(0)
      expect(yield* profiles.credential(account.id)).toEqual(original)
      expect(JSON.stringify(value)).not.toContain("SENTINEL")
    }),
  )

  it.instance("uses the stored strong account identity when the credential omits its header hint", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const account = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "remote-only",
        remoteID: "remote-header",
        credential: {
          access: "HEADER_TOKEN_SENTINEL",
          refresh: "HEADER_REFRESH_SENTINEL",
          expires: Date.now() + 60_000,
        },
      })
      request = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("remote-header")
          return Response.json({ plan_type: "plus" })
        },
        { preconnect: fetch.preconnect },
      )
      const value = yield* usage.get(account.id)
      expect(value.snapshot.fetchState).toBe("ready")
      expect(JSON.stringify(value)).not.toContain("SENTINEL")
      expect(JSON.stringify(value)).not.toContain("remote-header")
    }),
  )

  it.instance(
    "authenticates independent accounts against a controlled HTTP endpoint and isolates real timeouts",
    () => {
      const sent: Array<{ bearer: string | null; account: string | null }> = []
      const delayed = Promise.withResolvers<Response>()
      let timeout = false
      return Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(req) {
              const bearer = req.headers.get("authorization")
              const account = req.headers.get("chatgpt-account-id")
              sent.push({ bearer, account })
              if (timeout && account === "remote-http-A") return delayed.promise
              return Response.json({
                plan_type: "plus",
                rate_limit: { primary_window: { used_percent: account === "remote-http-A" ? 14 : 67 } },
              })
            },
          }),
        ),
        (server) =>
          Effect.gen(function* () {
            const usage = yield* AccountUsage.Service
            request = Object.assign((_input: RequestInfo | URL, init?: RequestInit) => fetch(server.url, init), {
              preconnect: fetch.preconnect,
            })
            const a = yield* create("http-A", "HTTP_SYNTHETIC_ACCESS_A")
            const b = yield* create("http-B", "HTTP_SYNTHETIC_ACCESS_B")
            const [first, other] = yield* Effect.all([usage.get(a.id), usage.get(b.id)], { concurrency: "unbounded" })
            expect(sent).toContainEqual({ bearer: "Bearer HTTP_SYNTHETIC_ACCESS_A", account: "remote-http-A" })
            expect(sent).toContainEqual({ bearer: "Bearer HTTP_SYNTHETIC_ACCESS_B", account: "remote-http-B" })
            expect(first.snapshot.windows.at(0)?.used).toBe(14)
            expect(other.snapshot.windows.at(0)?.used).toBe(67)
            timeout = true
            const failed = yield* usage.get(a.id, true)
            expect(failed.snapshot.fetchState).toBe("stale")
            expect(failed.snapshot.windows).toEqual(first.snapshot.windows)
            expect(yield* usage.get(b.id)).toBe(other)
            expect(JSON.stringify([first, other, failed])).not.toContain("HTTP_SYNTHETIC_ACCESS")
          }),
        (server) =>
          Effect.sync(() => {
            delayed.resolve(Response.json({ plan_type: "plus" }))
            server.stop(true)
          }),
      )
    },
    15_000, // The real usage deadline is five seconds, equal to Bun's default test deadline.
  )

  it.instance("cannot recreate a profile removed while its approved refresh is pending", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const a = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "refresh-deleted",
        remoteID: "remote-refresh-deleted",
        credential: {
          access: "EXPIRED_SENTINEL",
          refresh: "REFRESH_SENTINEL",
          expires: 0,
          accountID: "remote-refresh-deleted",
        },
      })
      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<Response>()
      const urls: string[] = []
      request = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          urls.push(String(input))
          expect(init?.redirect).toBe("error")
          entered.resolve()
          return gate.promise
        },
        { preconnect: fetch.preconnect },
      )
      const pending = Effect.runPromise(usage.get(a.id))
      yield* Effect.promise(() => entered.promise)
      yield* profiles.remove(a.id)
      gate.resolve(
        Response.json({ access_token: "NEW_ACCESS_SENTINEL", refresh_token: "NEW_REFRESH_SENTINEL", expires_in: 3600 }),
      )
      const value = yield* Effect.promise(() => pending)
      expect(value.snapshot.fetchState).toBe("unavailable")
      expect(yield* profiles.credential(a.id)).toBeUndefined()
      expect(yield* profiles.get(a.id)).toBeUndefined()
      expect(urls).toEqual(["https://auth.openai.com/oauth/token"])
      expect(JSON.stringify(value)).not.toContain("SENTINEL")
      expect((yield* usage.get(a.id)).snapshot.fetchState).toBe("unavailable")
      expect(urls).toHaveLength(1)
    }),
  )

  it.instance("isolates timeout, HTTP, JSON and authentication failures without changing credentials", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const a = yield* create("healthy-A", "SYNTHETIC_ACCESS_A")
      const b = yield* create("failing-B", "SYNTHETIC_ACCESS_B")
      const healthy = yield* usage.get(a.id)
      const original = yield* profiles.credential(b.id)
      for (const failure of ["timeout", "http", "json", "401", "403"] as const) {
        request = Object.assign(
          async () => {
            if (failure === "timeout") throw new DOMException("SYNTHETIC_ACCESS_B", "TimeoutError")
            if (failure === "json")
              return new Response("SYNTHETIC_ACCESS_B", { headers: { "content-type": "application/json" } })
            return new Response("SYNTHETIC_ACCESS_B", { status: failure === "http" ? 503 : Number(failure) })
          },
          { preconnect: fetch.preconnect },
        )
        const result = yield* usage.get(b.id, true)
        expect(result.accountID).toBe(b.id)
        expect(result.snapshot.fetchState).toBe("unavailable")
        expect(result.snapshot.error?.retryable).toBe(failure !== "401" && failure !== "403")
        expect(JSON.stringify(result)).not.toContain("SYNTHETIC_ACCESS_B")
        expect(yield* profiles.credential(b.id)).toEqual(original)
        expect(yield* usage.get(a.id)).toBe(healthy)
      }
    }),
  )

  it.instance("discards deleted and reauthenticated account responses without touching another account", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const b = yield* create("unchanged-B", "token-B")
      const cached = yield* usage.get(b.id)
      for (const change of ["delete", "reauth"] as const) {
        const a = yield* create(`pending-${change}`, "SYNTHETIC_OLD_TOKEN")
        const entered = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<Response>()
        let calls = 0
        request = Object.assign(
          async () => {
            calls++
            entered.resolve()
            return gate.promise
          },
          { preconnect: fetch.preconnect },
        )
        const pending = Effect.runPromise(usage.get(a.id))
        yield* Effect.promise(() => entered.promise)
        if (change === "delete") yield* profiles.remove(a.id)
        if (change === "reauth")
          yield* profiles.compareAndSwapCredential({
            id: a.id,
            revision: 0,
            value: {
              access: "SYNTHETIC_NEW_TOKEN",
              refresh: "new-refresh",
              expires: Date.now() + 60_000,
              accountID: `remote-pending-${change}`,
            },
          })
        gate.resolve(Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 92 } } }))
        const stale = yield* Effect.promise(() => pending)
        expect(stale.accountID).toBe(a.id)
        expect(stale.snapshot.fetchState).toBe("unavailable")
        expect(yield* usage.get(b.id)).toBe(cached)
        if (change === "delete") {
          const gone = yield* usage.get(a.id, true)
          expect(gone.snapshot.fetchState).toBe("unavailable")
          expect(calls).toBe(1)
          expect(yield* profiles.get(a.id)).toBeUndefined()
        }
        if (change === "reauth") {
          request = Object.assign(async () => Response.json({ plan_type: "plus" }), { preconnect: fetch.preconnect })
          const fresh = yield* usage.get(a.id)
          expect(fresh.snapshot.fetchState).toBe("ready")
          expect(fresh.generation).toBeGreaterThan(stale.generation)
        }
      }
    }),
  )

  it.instance("rejects a changed revision before transport handoff", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* create("dispatch-race", "old-token")
      let calls = 0
      request = Object.assign(
        async () => {
          calls++
          return Response.json({ plan_type: "plus" })
        },
        { preconnect: fetch.preconnect },
      )
      const wrapped: ProviderAccountProfiles.Interface = {
        ...profiles,
        dispatch: (id, send) =>
          Effect.gen(function* () {
            yield* profiles.compareAndSwapCredential({
              id,
              revision: 0,
              value: {
                access: "new-token",
                refresh: "new-refresh",
                expires: Date.now() + 60_000,
                accountID: "remote-dispatch-race",
              },
            })
            return yield* profiles.dispatch(id, send)
          }),
      }
      const result = yield* Effect.gen(function* () {
        return yield* (yield* AccountUsage.Service).get(a.id)
      }).pipe(
        Effect.provide(
          AccountUsage.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAccountProfiles.Service, wrapped),
                Layer.succeed(ProviderUsage.Transport, transport),
              ),
            ),
            Layer.fresh,
          ),
        ),
      )
      expect(result.snapshot.fetchState).toBe("unavailable")
      expect(calls).toBe(0)
      expect((yield* profiles.credential(a.id))?.revision).toBe(1)
    }),
  )

  it.instance("recreates an empty usage cache when its service restarts", () =>
    Effect.gen(function* () {
      const usage = yield* AccountUsage.Service
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* create("restart", "restart-token")
      let calls = 0
      request = Object.assign(
        async () => {
          calls++
          return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: calls } } })
        },
        { preconnect: fetch.preconnect },
      )
      const first = yield* usage.get(a.id)
      expect(yield* usage.get(a.id)).toBe(first)
      const next = yield* Effect.gen(function* () {
        return yield* (yield* AccountUsage.Service).get(a.id)
      }).pipe(
        Effect.provide(
          AccountUsage.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAccountProfiles.Service, profiles),
                Layer.succeed(ProviderUsage.Transport, transport),
              ),
            ),
            Layer.fresh,
          ),
        ),
      )
      expect(calls).toBe(2)
      expect(next.accountID).toBe(first.accountID)
      expect(next.snapshot.windows.at(0)?.used).toBe(2)
    }),
  )

  it.instance("scopes results to explicit profile IDs and revalidates before cached responses", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const sent: Array<{
        authorization: string | null
        account: string | null
        url: string
        redirect: RequestRedirect | undefined
      }> = []
      request = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          sent.push({
            authorization: headers.get("authorization"),
            account: headers.get("ChatGPT-Account-Id"),
            url: String(_input),
            redirect: init?.redirect,
          })
          return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25 } } })
        },
        { preconnect: fetch.preconnect },
      )
      const a = yield* create("A", "token-A")
      const b = yield* create("B", "token-B")
      yield* profiles.selectDefault("openai", "chatgpt-oauth", a.id)

      const first = yield* usage.get(a.id)
      yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
      const cached = yield* usage.get(a.id)
      const other = yield* usage.get(b.id)

      expect(first.accountID).toBe(a.id)
      expect(first.snapshot.fetchState).toBe("ready")
      expect(cached).toBe(first)
      expect(other.accountID).toBe(b.id)
      expect(other.snapshot.fetchState).toBe("ready")
      expect(first.snapshot.id).toBe(`codex-chatgpt:${a.id}`)
      expect(other.snapshot.id).toBe(`codex-chatgpt:${b.id}`)
      expect(sent).toEqual([
        {
          authorization: "Bearer token-A",
          account: "remote-A",
          url: "https://chatgpt.com/backend-api/wham/usage",
          redirect: "error",
        },
        {
          authorization: "Bearer token-B",
          account: "remote-B",
          url: "https://chatgpt.com/backend-api/wham/usage",
          redirect: "error",
        },
      ])
      yield* profiles.remove(a.id)
      const deleted = yield* usage.get(a.id)
      expect(deleted.accountID).toBe(a.id)
      expect(deleted.snapshot.fetchState).toBe("unavailable")
      expect(deleted.generation).toBeGreaterThan(first.generation)
    }),
  )

  it.instance("coalesces same-account requests and keeps accounts independent", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const a = yield* create("coalesce-A", "token-A")
      const b = yield* create("coalesce-B", "token-B")
      const entered = Promise.withResolvers<void>()
      const separate = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<Response>()
      let calls = 0
      request = Object.assign(
        async () => {
          calls++
          if (calls === 1) entered.resolve()
          if (calls === 2) separate.resolve()
          return gate.promise.then((response) => response.clone())
        },
        { preconnect: fetch.preconnect },
      )
      const one = Effect.runPromise(usage.get(a.id))
      yield* Effect.promise(() => entered.promise)
      const two = Effect.runPromise(usage.get(a.id))
      const three = Effect.runPromise(usage.get(b.id))
      yield* Effect.promise(() => separate.promise)
      expect(calls).toBe(2)
      gate.resolve(Response.json({ plan_type: "plus" }))
      const results = yield* Effect.promise(() => Promise.all([one, two, three]))
      expect(results[0]).toEqual(results[1])
      expect(results[2].accountID).toBe(b.id)
      expect(results.every((result) => result.snapshot.fetchState === "ready")).toBe(true)
      yield* profiles.remove(a.id)
    }),
  )

  it.instance("invalidates cached usage after reauthentication and never exposes arbitrary quota labels", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const account = yield* create("reauth", "first-secret")
      const bodies = [
        { plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } },
        {
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 20 } },
          additional_rate_limits: [
            {
              limit_name: "sentinel-secret",
              metered_feature: "https://example.invalid/path?token=sentinel-secret",
              rate_limit: { primary_window: { used_percent: 99 } },
            },
          ],
        },
      ]
      let index = 0
      const requests: string[] = []
      request = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new Headers(init?.headers).get("authorization") ?? "")
          return Response.json(bodies[index++] ?? bodies.at(-1))
        },
        { preconnect: fetch.preconnect },
      )
      yield* usage.get(account.id)
      yield* profiles.compareAndSwapCredential({
        id: account.id,
        revision: 0,
        value: {
          access: "second-secret",
          refresh: "refresh-reauth",
          expires: Date.now() + 60_000,
          accountID: "remote-reauth",
        },
      })
      const next = yield* usage.get(account.id)
      expect(requests).toEqual(["Bearer first-secret", "Bearer second-secret"])
      expect(next.snapshot.fetchState).toBe("ready")
      expect(JSON.stringify(next.snapshot)).not.toContain("sentinel-secret")
      expect(JSON.stringify(next.snapshot)).not.toContain("example.invalid")
      expect(next.snapshot.windows.at(-1)?.used).toBe(99)
    }),
  )

  it.instance("does not retain a previous snapshot after 401/403", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const account = yield* create("auth-failure", "auth-secret")
      let denied = false
      request = Object.assign(
        async () => {
          if (denied) return new Response("sentinel-secret", { status: 401 })
          return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 15 } } })
        },
        { preconnect: fetch.preconnect },
      )
      yield* usage.get(account.id)
      denied = true
      const value = yield* usage.get(account.id, true)
      const credential = yield* profiles.credential(account.id)
      expect(value.snapshot.fetchState).toBe("unavailable")
      expect(value.snapshot.error?.retryable).toBe(false)
      expect(credential?.revision).toBe(0)
      expect(JSON.stringify(value)).not.toContain("sentinel-secret")
    }),
  )

  it.instance("refreshes expired credentials through the existing account refresh path", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const usage = yield* AccountUsage.Service
      const account = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "expired",
        remoteID: "remote-expired",
        credential: { access: "expired-access", refresh: "refresh-token", expires: 0, accountID: "remote-expired" },
      })
      const calls: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = []
      request = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect })
          if (url === "https://auth.openai.com/oauth/token")
            return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 })
          return Response.json({ plan_type: "plus" })
        },
        { preconnect: fetch.preconnect },
      )
      const value = yield* usage.get(account.id)
      const credential = yield* profiles.credential(account.id)
      expect(value.snapshot.fetchState).toBe("ready")
      expect(credential?.revision).toBe(1)
      expect(calls.map((call) => call.url)).toEqual([
        "https://auth.openai.com/oauth/token",
        "https://chatgpt.com/backend-api/wham/usage",
      ])
      expect(calls.at(-1)?.authorization).toBe("Bearer fresh-access")
      expect(calls.every((call) => call.redirect === "error")).toBe(true)
    }),
  )

  it.instance("fails closed when disabled or when an account is missing", () =>
    Effect.gen(function* () {
      const usage = yield* AccountUsage.Service
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
      const disabled = yield* usage.get("pacc_disabled")
      expect(disabled.snapshot.fetchState).toBe("unavailable")
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      const missing = yield* usage.get("pacc_missing")
      expect(missing.snapshot.fetchState).toBe("unavailable")
      expect(missing.accountID).toBe("pacc_missing")
    }),
  )

  it.instance("invalidates cached results when the feature is disabled", () =>
    Effect.gen(function* () {
      const usage = yield* AccountUsage.Service
      const profiles = yield* ProviderAccountProfiles.Service
      const account = yield* create("dynamic-disable", "disable-secret")
      let calls = 0
      request = Object.assign(
        async () => {
          calls++
          return Response.json({ plan_type: "plus" })
        },
        { preconnect: fetch.preconnect },
      )
      const loaded = yield* usage.get(account.id)
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
      const blocked = yield* usage.get(account.id)
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      const reenabled = yield* usage.get(account.id)
      expect(loaded.snapshot.fetchState).toBe("ready")
      expect(blocked.snapshot.fetchState).toBe("unavailable")
      expect(reenabled.snapshot.fetchState).toBe("ready")
      expect(calls).toBe(2)

      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<Response>()
      request = Object.assign(
        async () => {
          entered.resolve()
          return gate.promise
        },
        { preconnect: fetch.preconnect },
      )
      const pending = Effect.runPromise(usage.get(account.id, true))
      yield* Effect.promise(() => entered.promise)
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
      gate.resolve(Response.json({ plan_type: "plus" }))
      const inFlight = yield* Effect.promise(() => pending)
      expect(inFlight.snapshot.fetchState).toBe("unavailable")
      yield* profiles.remove(account.id)
    }),
  )
})
