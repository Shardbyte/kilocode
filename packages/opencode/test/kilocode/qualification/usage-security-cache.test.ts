import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderUsage } from "@opencode-ai/core/kilocode/provider-usage"
import { afterEach, expect, setSystemTime } from "bun:test"
import { Effect, Layer } from "effect"
import * as AccountUsage from "@/kilocode/provider/account-usage"
import { testEffect } from "../../lib/effect"

const transport = ProviderUsage.Transport.of({
  fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => request(input, init), {
    preconnect: fetch.preconnect,
  }),
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
const env = LayerNode.compile(LayerNode.group([AccountUsage.node, ProviderAccountProfiles.node]), [
  [ProviderUsage.transportNode, Layer.succeed(ProviderUsage.Transport, transport)],
])
const it = testEffect(env)
const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const priorAuth = process.env.KILO_AUTH_CONTENT
const priorAuthIsSet = Object.hasOwn(process.env, "KILO_AUTH_CONTENT")
let request: typeof fetch = Object.assign(
  async () => Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } }),
  { preconnect: fetch.preconnect },
)

afterEach(() => {
  if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
  if (priorAuthIsSet) process.env.KILO_AUTH_CONTENT = priorAuth ?? ""
  else delete process.env.KILO_AUTH_CONTENT
  request = Object.assign(
    async () => Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } }),
    { preconnect: fetch.preconnect },
  )
  setSystemTime()
})

const create = Effect.fn("UsageSecurityCache.create")(function* (label: string, expires = Date.now() + 60_000) {
  const profiles = yield* ProviderAccountProfiles.Service
  return yield* profiles.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label,
    remoteID: `remote-${label}`,
    credential: {
      access: `SYNTHETIC_ACCESS_${label}`,
      refresh: `SYNTHETIC_REFRESH_${label}`,
      expires,
      accountID: `remote-${label}`,
    },
  })
})

it.instance("usage cache expiry refetches only the requested account without stale cross-account values", () => {
  const base = 1_800_000_000_000
  let calls = 0
  const auth: string[] = []
  request = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      const headers = new Headers(init?.headers)
      auth.push(headers.get("authorization") ?? "")
      const remote = headers.get("chatgpt-account-id")
      return Response.json({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: remote === "remote-A" ? calls : 70 } },
      })
    },
    { preconnect: fetch.preconnect },
  )
  return Effect.acquireUseRelease(
    Effect.sync(() => setSystemTime(base)),
    () =>
      Effect.gen(function* () {
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        const legacy = JSON.stringify({ openai: { type: "api", key: "SYNTHETIC_LEGACY_AUTH" } })
        process.env.KILO_AUTH_CONTENT = legacy
        const usage = yield* AccountUsage.Service
        const a = yield* create("A")
        const b = yield* create("B")
        const firstA = yield* usage.get(a.id)
        const firstB = yield* usage.get(b.id)
        setSystemTime(base + 59_999)
        expect(yield* usage.get(a.id)).toBe(firstA)
        expect(yield* usage.get(b.id)).toBe(firstB)
        expect(calls).toBe(2)
        setSystemTime(base + 60_000)
        const secondA = yield* usage.get(a.id)
        const secondB = yield* usage.get(b.id)
        expect(secondA.generation).toBeGreaterThan(firstA.generation)
        expect(secondB.generation).toBeGreaterThan(firstB.generation)
        expect(secondA.snapshot.windows.at(0)?.used).toBeGreaterThan(firstA.snapshot.windows.at(0)?.used ?? -1)
        expect(secondB.accountID).toBe(b.id)
        expect(calls).toBeGreaterThan(2)
        expect(auth.every((value) => !value.includes("SYNTHETIC_LEGACY_AUTH"))).toBe(true)
        expect(process.env.KILO_AUTH_CONTENT).toBe(legacy)
        expect(JSON.stringify(secondA)).not.toContain("SYNTHETIC_")
        expect(JSON.stringify(firstB)).not.toContain("SYNTHETIC_")
      }),
    () => Effect.sync(() => setSystemTime()),
  )
})

it.instance("coalesces concurrent expired-token refresh and usage fetch through the real profile store", () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<Response>()
  let refreshes = 0
  let usages = 0
  request = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://auth.openai.com/oauth/token") {
        refreshes++
        expect(init?.redirect).toBe("error")
        return Response.json({
          access_token: "SYNTHETIC_FRESH_ACCESS",
          refresh_token: "SYNTHETIC_FRESH_REFRESH",
          expires_in: 3600,
        })
      }
      usages++
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer SYNTHETIC_FRESH_ACCESS")
      entered.resolve()
      return gate.promise.then((response) => response.clone())
    },
    { preconnect: fetch.preconnect },
  )
  return Effect.gen(function* () {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const profiles = yield* ProviderAccountProfiles.Service
    const usage = yield* AccountUsage.Service
    const account = yield* create("Concurrent", 0)
    const one = Effect.runPromise(usage.get(account.id))
    yield* Effect.promise(() => entered.promise)
    const two = Effect.runPromise(usage.get(account.id))
    gate.resolve(Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 42 } } }))
    const values = yield* Effect.promise(() => Promise.all([one, two]))
    expect(refreshes).toBe(1)
    expect(usages).toBe(1)
    expect(values[0]).toEqual(values[1])
    expect(values[0]?.snapshot.windows.at(0)?.used).toBe(42)
    expect((yield* profiles.credential(account.id))?.revision).toBe(1)
    expect(JSON.stringify(values)).not.toContain("SYNTHETIC_")
  })
})
