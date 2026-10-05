import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { Session } from "@/session/session"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { makeFetch, refresh } from "@/kilocode/provider/codex-profile"
import { testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, ProviderAccountProfiles.node])))
const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const model = { providerID: "openai", id: "gpt-5-mini" }

beforeEach(() => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
})

afterEach(() => {
  if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
})

const create = Effect.fn("UtilityLifecycle.create")(function* (label: string, expires = Date.now() + 60_000) {
  const profiles = yield* ProviderAccountProfiles.Service
  return yield* profiles.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label,
    remoteID: `remote-${label}`,
    credential: {
      access: `UTILITY_ACCESS_${label}`,
      refresh: `UTILITY_REFRESH_${label}`,
      expires,
      accountID: `remote-${label}`,
    },
  })
})

const context = (accountID: string) => ({
  kind: "account" as const,
  providerID: "openai" as const,
  authMode: "chatgpt-oauth" as const,
  accountID,
})

function transport(id: string, profiles: ProviderAccountProfiles.Interface, request: typeof fetch) {
  return makeFetch(id, {
    refresh: (key) => refresh(key, profiles, request),
    dispatch: (key, send) => Effect.runPromise(profiles.dispatch(key, send)),
    request,
  })
}

describe("utility authority lifetime", () => {
  it.instance("freezes admitted account identity across selection/default changes and concurrent handoffs", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* create("concurrent-A")
      const b = yield* create("concurrent-B")
      const selection = context(a.id)
      const first = yield* UtilityAccount.resolve({ operation: "commit-message", model, context: selection })
      const other = yield* UtilityAccount.resolve({ operation: "commit-message", model, context: context(b.id) })
      expect(first.mode).toBe("profile")
      expect(other.mode).toBe("profile")
      expect(first.id).not.toBe(other.id)
      if (first.mode !== "profile" || other.mode !== "profile") throw new Error("Expected profile authority")
      selection.accountID = b.id
      yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
      const handed = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const calls: Array<{ bearer: string | null; account: string | null }> = []
      const request = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          calls.push({ bearer: headers.get("authorization"), account: headers.get("chatgpt-account-id") })
          if (calls.length === 2) handed.resolve()
          return release.promise
        },
        { preconnect: fetch.preconnect },
      )
      const send = transport(first.profileID, profiles, request)
      const second = transport(other.profileID, profiles, request)
      yield* Effect.tryPromise(async () => {
        const pending = Promise.all([
          send("https://api.openai.com/v1/responses"),
          second("https://api.openai.com/v1/responses"),
        ])
        try {
          await handed.promise
          expect(calls).toContainEqual({ bearer: "Bearer UTILITY_ACCESS_concurrent-A", account: "remote-concurrent-A" })
          expect(calls).toContainEqual({ bearer: "Bearer UTILITY_ACCESS_concurrent-B", account: "remote-concurrent-B" })
          expect(first.profileID).toBe(a.id)
          expect(JSON.stringify([first, other])).not.toContain("UTILITY_ACCESS_")
          expect(JSON.stringify([first, other])).not.toContain("UTILITY_REFRESH_")
        } finally {
          release.resolve(Response.json({ ok: true }))
          await pending
        }
      })
    }),
  )

  it.instance("allows a handed-off response but denies later retry after account deletion", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* create("deleted-A")
      const identity = yield* UtilityAccount.resolve({ operation: "commit-message", model, context: context(a.id) })
      if (identity.mode !== "profile") throw new Error("Expected profile authority")
      const handed = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const calls: string[] = []
      const request = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          calls.push(new Headers(init?.headers).get("authorization") ?? "")
          handed.resolve()
          return release.promise
        },
        { preconnect: fetch.preconnect },
      )
      const send = transport(identity.profileID, profiles, request)
      const pending = send("https://api.openai.com/v1/responses")
      yield* Effect.promise(() => handed.promise)
      yield* profiles.remove(a.id)
      release.resolve(Response.json({ ok: true }))
      expect((yield* Effect.promise(() => pending)).ok).toBe(true)
      const retry = yield* Effect.exit(Effect.tryPromise(() => send("https://api.openai.com/v1/responses")))
      expect(retry._tag).toBe("Failure")
      expect(calls).toEqual(["Bearer UTILITY_ACCESS_deleted-A"])
      expect(yield* profiles.credential(a.id)).toBeUndefined()
    }),
  )

  it.instance("denies dispatch when the account is deleted after admission but before handoff", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* create("before-handoff")
      const identity = yield* UtilityAccount.resolve({ operation: "commit-message", model, context: context(a.id) })
      if (identity.mode !== "profile") throw new Error("Expected profile authority")
      yield* profiles.remove(a.id)
      let calls = 0
      const request = Object.assign(
        async () => {
          calls++
          return Response.json({ ok: true })
        },
        { preconnect: fetch.preconnect },
      )
      const send = transport(identity.profileID, profiles, request)
      const result = yield* Effect.exit(Effect.tryPromise(() => send("https://api.openai.com/v1/responses")))
      expect(result._tag).toBe("Failure")
      expect(calls).toBe(0)
    }),
  )

  it.instance("cannot overwrite reauthentication with a paused stale refresh", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const a = yield* create("refresh-race", 0)
      const identity = yield* UtilityAccount.resolve({ operation: "commit-message", model, context: context(a.id) })
      if (identity.mode !== "profile") throw new Error("Expected profile authority")
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const calls: string[] = []
      const request = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === "https://auth.openai.com/oauth/token") {
            expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("UTILITY_REFRESH_refresh-race")
            entered.resolve()
            return release.promise
          }
          calls.push(new Headers(init?.headers).get("authorization") ?? "")
          return Response.json({ ok: true })
        },
        { preconnect: fetch.preconnect },
      )
      const send = transport(identity.profileID, profiles, request)
      const pending = send("https://api.openai.com/v1/responses").then(
        () => "success",
        () => "failed",
      )
      yield* Effect.promise(() => entered.promise)
      const value = {
        access: "UTILITY_NEW_ACCESS",
        refresh: "UTILITY_NEW_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "remote-refresh-race",
      }
      yield* profiles.reauthenticate({ id: a.id, revision: 0, remoteID: "remote-refresh-race", value })
      release.resolve(
        Response.json({
          access_token: "UTILITY_STALE_ACCESS",
          refresh_token: "UTILITY_STALE_REFRESH",
          expires_in: 3600,
        }),
      )
      expect(yield* Effect.promise(() => pending)).toBe("failed")
      expect(yield* profiles.credential(a.id)).toEqual({ value, revision: 1 })
      expect(calls).toEqual([])
      expect((yield* Effect.tryPromise(() => send("https://api.openai.com/v1/responses"))).ok).toBe(true)
      expect(calls).toEqual(["Bearer UTILITY_NEW_ACCESS"])
      expect(identity.profileID).toBe(a.id)
    }),
  )
})
