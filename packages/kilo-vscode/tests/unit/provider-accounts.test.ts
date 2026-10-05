import { describe, expect, test } from "bun:test"
import {
  accountDTOs,
  authorizationURL,
  bindingDTO,
  canAssignBinding,
  canRepair,
  isCurrentSessionResponse,
  reauthRevision,
  safeAccountError,
  sessionTarget,
  usageDTO,
} from "../../src/provider-accounts"

describe("provider account client rules", () => {
  test("repairs only an objectively absent bound profile", () => {
    expect(
      canRepair({ mode: "profile", profileID: "gone", authMode: "chatgpt-oauth", source: "explicit" }, new Set()),
    ).toBe(true)
    expect(
      canRepair(
        { mode: "profile", profileID: "present", authMode: "chatgpt-oauth", source: "explicit" },
        new Set(["present"]),
      ),
    ).toBe(false)
    expect(
      canRepair(
        { mode: "profile", profileID: "missing-credential", authMode: "chatgpt-oauth", source: "explicit" },
        new Set(["missing-credential"]),
      ),
    ).toBe(false)
    expect(canRepair({ mode: "unbound", reason: "profile-required" }, new Set())).toBe(false)
  })

  test("allows assignment only after a successful unbound lookup", () => {
    expect(canAssignBinding("ready", null)).toBe(true)
    expect(canAssignBinding("ready", { mode: "unbound", reason: "profile-required" })).toBe(true)
    expect(canAssignBinding("error", null)).toBe(false)
    expect(canAssignBinding("loading", null)).toBe(false)
    expect(
      canAssignBinding("ready", { mode: "profile", profileID: "bound", authMode: "chatgpt-oauth", source: "explicit" }),
    ).toBe(false)
  })

  test("never forwards backend error text", () => {
    expect(safeAccountError({ error: "Conflict", message: "secret token" })).toContain("active turn")
    expect(safeAccountError({ error: "Disabled", message: "secret token" })).toBeUndefined()
    expect(safeAccountError(new Error("secret token"))).toBe("Provider account operation failed. Refresh and retry.")
  })

  test("freezes assignment targets and rejects stale session responses", () => {
    let current = "session-a"
    const target = sessionTarget(current, () => current)
    current = "session-b"
    expect(target.id).toBe("session-a")
    expect(target.isCurrent()).toBe(false)
    expect(isCurrentSessionResponse("session-a", current)).toBe(false)
    expect(isCurrentSessionResponse("session-b", current)).toBe(true)
  })

  test("projects only safe account, binding, and usage DTO fields", () => {
    const poison = "synthetic credential must not cross the webview boundary"
    const accounts = accountDTOs([
      {
        id: "profile-1",
        label: "Personal",
        isDefault: true,
        authState: "ready",
        revision: 4,
        accessToken: poison,
        refreshToken: poison,
        credential: poison,
      },
    ])
    const binding = bindingDTO({
      mode: "profile",
      profileID: "profile-1",
      authMode: "chatgpt-oauth",
      source: "explicit",
      credential: poison,
    })
    const usage = usageDTO({
      accountID: "profile-1",
      retrievedAt: "2026-10-05T00:00:00Z",
      snapshot: {
        planLabel: "Plus",
        fetchState: "ready",
        windows: [
          {
            id: "week",
            resource: "tokens",
            unit: "%",
            orientation: "used_percent",
            state: "active",
            used: 3,
            accessToken: poison,
          },
        ],
        credential: poison,
      },
      credential: poison,
    })
    const output = JSON.stringify({ accounts, binding, usage })
    expect(output).not.toContain(poison)
    expect(accounts).toEqual([{ id: "profile-1", label: "Personal", isDefault: true, authState: "ready", revision: 4 }])
    expect(binding).toEqual({ mode: "profile", profileID: "profile-1", authMode: "chatgpt-oauth", source: "explicit" })
    expect(usage?.snapshot.windows).toEqual([
      { id: "week", resource: "tokens", unit: "%", orientation: "used_percent", state: "active", used: 3 },
    ])
  })

  test("rejects missing or malformed reauthentication revisions", () => {
    expect(reauthRevision(undefined)).toBeUndefined()
    expect(reauthRevision("4")).toBeUndefined()
    expect(reauthRevision(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(reauthRevision(4)).toBe(4)
  })

  test("opens only the expected credential-free authorization endpoint", () => {
    expect(authorizationURL("https://auth.openai.com/oauth/authorize?state=synthetic")).toBe(
      "https://auth.openai.com/oauth/authorize?state=synthetic",
    )
    expect(authorizationURL("file:///synthetic-credential")).toBeUndefined()
    expect(authorizationURL("https://auth.openai.com.evil.example/oauth/authorize")).toBeUndefined()
    expect(authorizationURL("https://auth.openai.com/oauth/authorize?access_token=synthetic")).toBeUndefined()
    expect(authorizationURL("https://user:synthetic@auth.openai.com/oauth/authorize")).toBeUndefined()
  })
})
