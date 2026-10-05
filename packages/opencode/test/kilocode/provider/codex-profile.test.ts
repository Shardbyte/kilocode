import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { bindingSessionID, makeFetch, refresh, resolveBinding } from "../../../src/kilocode/provider/codex-profile"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"

describe("profile-bound Codex fetch", () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => server?.stop())

  test("fails closed for persisted profile and unbound session slots when disabled", () => {
    expect(() => resolveBinding({ mode: "profile", profileID: "profile-a", authMode: "chatgpt-oauth" }, false)).toThrow(
      "profiles are disabled",
    )
    expect(() => resolveBinding({ mode: "unbound", reason: "profile-required" }, false)).toThrow(
      "requires an OpenAI account binding",
    )
    expect(() => resolveBinding(undefined, false)).toThrow("no explicit OpenAI account binding")
    expect(resolveBinding({ mode: "legacy" }, false)).toEqual({ mode: "legacy" })
  })

  test("resolves synthetic branch requests only from their source session binding", () => {
    const source = { mode: "profile" as const, profileID: "profile-source", authMode: "chatgpt-oauth" }
    const context = { kind: "branch-name" as const, sourceSessionID: "session-source" }
    expect(bindingSessionID(context, "branch-name:session-source")).toBe("session-source")
    expect(resolveBinding(source, true, context)).toEqual({ mode: "profile", profileID: "profile-source" })
    expect(resolveBinding({ mode: "legacy" }, false, context)).toEqual({ mode: "legacy" })
    expect(() => resolveBinding(undefined, true, context)).toThrow("no explicit OpenAI account binding")
  })

  test("permits legacy utility auth only while profile mode is disabled", () => {
    const utility = { kind: "commit-message" as const }
    expect(bindingSessionID(utility, "commit-message")).toBeUndefined()
    expect(resolveBinding(undefined, false, utility)).toEqual({ mode: "legacy" })
    expect(() => resolveBinding(undefined, true, utility)).toThrow("no profile-bound session context")
  })

  test("pins account and bearer to the captured profile across attempts and default changes", async () => {
    const calls: Array<{ authorization: string | null; account: string | null }> = []
    server = Bun.serve({
      port: 0,
      fetch(request) {
        calls.push({
          authorization: request.headers.get("authorization"),
          account: request.headers.get("ChatGPT-Account-Id"),
        })
        return Response.json({ ok: true })
      },
    })
    let active = "profile-a"
    const profiles = {
      "profile-a": { access: "access-a", refresh: "refresh-a", expires: Date.now() + 60_000, accountID: "account-a" },
      "profile-b": { access: "access-b", refresh: "refresh-b", expires: Date.now() + 60_000, accountID: "account-b" },
    }
    const make = (id: string) =>
      makeFetch(id, {
        refresh: async (key) => {
          expect(key).toBe(id)
        },
        dispatch: async (key, transport) => {
          expect(key).toBe(id)
          const response = transport(profiles[key as keyof typeof profiles], 0)
          return { response }
        },
        request: (input, init) => fetch(`http://127.0.0.1:${server!.port}${new URL(String(input)).pathname}`, init),
      })

    const fetchA = make(active)
    active = "profile-b"
    const fetchB = make(active)
    await fetchA("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    await fetchB("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    await fetchA("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(calls).toEqual([
      { authorization: "Bearer access-a", account: "account-a" },
      { authorization: "Bearer access-b", account: "account-b" },
      { authorization: "Bearer access-a", account: "account-a" },
    ])
  })

  test("releases dispatch handoff before awaiting the HTTP response", async () => {
    let release!: (response: Response) => void
    const response = new Promise<Response>((resolve) => (release = resolve))
    let handed = false
    const send = makeFetch("profile-a", {
      refresh: async () => {},
      dispatch: async (_id, transport) => {
        const response = transport({ access: "access-a", refresh: "refresh-a", expires: Date.now() + 1000 }, 3)
        handed = true
        return { response }
      },
      request: () => response,
    })

    const pending = send("https://api.openai.com/v1/responses")
    await Promise.resolve()
    expect(handed).toBe(true)
    release(new Response("ok"))
    expect(await (await pending).text()).toBe("ok")
  })

  test("rejects unsupported origins and paths before refreshing or dispatching", async () => {
    const calls: string[] = []
    const send = makeFetch("profile-a", {
      refresh: async () => calls.push("refresh"),
      dispatch: async (_id, transport) => {
        calls.push("dispatch")
        return { response: transport({ access: "secret", refresh: "refresh", expires: Date.now() }, 1) }
      },
      request: async () => {
        calls.push("request")
        return Response.json({})
      },
    })

    await expect(send("https://attacker.example/v1/responses")).rejects.toThrow("official Responses endpoint")
    await expect(send("https://api.openai.com/v1/chat/completions")).rejects.toThrow("official Responses endpoint")
    expect(calls).toEqual([])
  })

  test("fails closed on a provider redirect before a second origin is contacted", async () => {
    const calls: Array<{ authorization: string | null; redirect: RequestRedirect | undefined; url: string }> = []
    const send = makeFetch("profile-a", {
      refresh: async () => {},
      dispatch: async (_id, transport) => ({
        response: transport({ access: "secret", refresh: "refresh", expires: Date.now() }, 1),
      }),
      request: async (input, init) => {
        calls.push({
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
          url: String(input),
        })
        if (init?.redirect === "error") throw new TypeError("Redirect disallowed")
        return new Response(null, { status: 302, headers: { Location: "https://attacker.example/steal" } })
      },
    })

    await expect(send("https://api.openai.com/v1/responses")).rejects.toThrow("Redirect disallowed")
    expect(calls).toEqual([
      {
        authorization: "Bearer secret",
        redirect: "error",
        url: "https://chatgpt.com/backend-api/codex/responses",
      },
    ])
  })

  test("hands refresh-token HTTP through the account dispatch gate", async () => {
    const calls: Array<{ token: string | undefined; url: string | undefined }> = []
    const secret: { access: string; refresh: string; expires: number; accountID?: string } = {
      access: "expired",
      refresh: "refresh-a",
      expires: 0,
    }
    const auth = `e30.${btoa(JSON.stringify({ sub: "unrelated-subject" }))}.sig`
    let written: { value: typeof secret; remoteID?: string | null } | undefined
    const profiles = {
      withRefresh: (_id: string, work: Effect.Effect<unknown, unknown>) => work,
      credential: () => Effect.succeed({ value: secret, revision: 4 }),
      get: () => Effect.succeed({ remoteID: "account-a" }),
      dispatch: (_id: string, transport: (auth: typeof secret, revision: number) => Promise<Response>) => {
        const response = transport(secret, 4)
        return Effect.succeed({ response })
      },
      reauthenticate: (input: { value: typeof secret; remoteID?: string | null }) => {
        written = input
        return Effect.succeed(5)
      },
    } as unknown as ProviderAccountProfiles.Interface
    const request = ((input, init) => {
      calls.push({
        token: new URLSearchParams(String(init?.body)).get("refresh_token") ?? undefined,
        url: String(input),
      })
      return Promise.resolve(
        Response.json({
          access_token: auth,
          refresh_token: "refresh-new",
          expires_in: 60,
        }),
      )
    }) as typeof fetch

    const result = await refresh("profile-a", profiles, request)
    expect(result).toEqual({
      value: { access: auth, refresh: "refresh-new", expires: expect.any(Number), accountID: "account-a" },
      revision: 5,
    })
    expect(written?.remoteID).toBe("account-a")
    expect(written?.value.accountID).toBe("account-a")
    expect(calls).toEqual([{ token: "refresh-a", url: "https://auth.openai.com/oauth/token" }])
  })

  test("does not follow refresh endpoint redirects", async () => {
    const calls: Array<{ redirect: RequestRedirect | undefined; url: string }> = []
    const secret = { access: "expired", refresh: "refresh-a", expires: 0 }
    const profiles = {
      withRefresh: (_id: string, work: Effect.Effect<unknown, unknown>) => work,
      credential: () => Effect.succeed({ value: secret, revision: 2 }),
      get: () => Effect.succeed({ remoteID: "account-a" }),
      dispatch: (_id: string, transport: (auth: typeof secret, revision: number) => Promise<Response>) =>
        Effect.succeed({ response: transport(secret, 2) }),
      reauthenticate: () => Effect.succeed(3),
    } as unknown as ProviderAccountProfiles.Interface
    const request = ((input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect })
      if (init?.redirect === "error") return Promise.reject(new TypeError("Redirect disallowed"))
      return Promise.resolve(new Response(null, { status: 302, headers: { Location: "https://attacker.example/" } }))
    }) as typeof fetch

    const result = await refresh("profile-a", profiles, request).catch((err: unknown) => err)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain("Redirect disallowed")
    expect(calls).toEqual([{ url: "https://auth.openai.com/oauth/token", redirect: "error" }])
  })
})
