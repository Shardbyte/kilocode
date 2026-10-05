import { afterEach, describe, expect, test } from "bun:test"
import { cancelCodexOAuth, completeCodexOAuth, startCodexOAuth } from "../../../src/plugin/openai/codex"

const original = globalThis.fetch

afterEach(() => {
  globalThis.fetch = original
})

function jwt(payload: object) {
  return `e30.${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.sig`
}

async function callback(state: string, params: Record<string, string>) {
  const url = new URL("http://localhost:1455/auth/callback")
  url.searchParams.set("state", state)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return original(url)
}

describe.serial("Codex OAuth operation isolation", () => {
  test("completes concurrent flows independently and claims callback once", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(String(new URLSearchParams(String(init?.body)).get("code")))
      const accountID = calls.at(-1) === "code-a" ? "account-a" : "account-b"
      return Response.json({
        id_token: jwt({ chatgpt_account_id: accountID }),
        access_token: `access-${accountID}`,
        refresh_token: `refresh-${accountID}`,
        expires_in: 60,
      })
    }) as typeof fetch

    const a = await startCodexOAuth()
    const b = await startCodexOAuth()
    const stateA = new URL(a.url).searchParams.get("state")!
    const stateB = new URL(b.url).searchParams.get("state")!
    const doneA = completeCodexOAuth(a.operationID)
    const doneB = completeCodexOAuth(b.operationID)
    await expect(completeCodexOAuth(a.operationID)).rejects.toThrow("missing or expired")

    expect((await callback(stateB, { code: "code-b" })).status).toBe(200)
    expect((await callback(stateB, { code: "duplicate" })).status).toBe(400)
    expect((await callback(stateA, { code: "code-a" })).status).toBe(200)
    expect(await doneB).toMatchObject({ credential: { access: "access-account-b", accountID: "account-b" } })
    expect(await doneA).toMatchObject({ credential: { access: "access-account-a", accountID: "account-a" } })
    expect(calls).toEqual(["code-b", "code-a"])
    await expect(completeCodexOAuth(a.operationID)).rejects.toThrow("missing or expired")
  })

  test("cancels only the selected operation even if completion has not started", async () => {
    const a = await startCodexOAuth()
    const b = await startCodexOAuth()
    cancelCodexOAuth(a.operationID)
    await expect(completeCodexOAuth(a.operationID)).rejects.toThrow("missing or expired")
    cancelCodexOAuth(b.operationID)
    await expect(completeCodexOAuth(b.operationID)).rejects.toThrow("missing or expired")
  })

  test("expires operations after a successful but unconsumed callback", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 }),
      )) as unknown as typeof fetch
    const auth = await startCodexOAuth(10)
    const state = new URL(auth.url).searchParams.get("state")!
    expect((await callback(state, { code: "code" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(completeCodexOAuth(auth.operationID)).rejects.toThrow("missing or expired")
  })

  test("returns provider callback failures as operation errors", async () => {
    const auth = await startCodexOAuth()
    const state = new URL(auth.url).searchParams.get("state")!
    const done = completeCodexOAuth(auth.operationID).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    expect((await callback(state, { error: "access_denied" })).status).toBe(200)
    const result = await done
    const err = "error" in result ? result.error : undefined
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("access_denied")
    await expect(completeCodexOAuth(auth.operationID)).rejects.toThrow("missing or expired")
  })

  test("rejects a failed token exchange and consumes the operation", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("denied", { status: 401 }))) as unknown as typeof fetch
    const auth = await startCodexOAuth()
    const state = new URL(auth.url).searchParams.get("state")!
    const done = completeCodexOAuth(auth.operationID).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    expect((await callback(state, { code: "code" })).status).toBe(200)
    const result = await done
    expect("error" in result && result.error).toBeInstanceOf(Error)
    expect("error" in result && (result.error as Error).message).toContain("Token exchange failed: 401")
    await expect(completeCodexOAuth(auth.operationID)).rejects.toThrow("missing or expired")
  })
})
