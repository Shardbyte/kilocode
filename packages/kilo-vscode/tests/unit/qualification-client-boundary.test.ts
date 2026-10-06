import { describe, expect, test } from "bun:test"
import {
  accountDTOs,
  bindingDTO,
  canAssignBinding,
  canRepair,
  isCurrentSessionResponse,
  sessionTarget,
} from "../../src/provider-accounts"

describe("client boundary qualification", () => {
  test("freezes the prepared session and rejects a late response after switching sessions", () => {
    let active = "session-a"
    const prepared = sessionTarget(active, () => active)

    active = "session-b"

    expect(prepared.id).toBe("session-a")
    expect(prepared.isCurrent()).toBe(false)
    expect(isCurrentSessionResponse("session-a", active)).toBe(false)
    expect(isCurrentSessionResponse("session-b", active)).toBe(true)
  })

  test("projects credential-free current and legacy response shapes and rejects unsupported shapes", () => {
    const marker = "qualification-secret-marker"
    const accounts = accountDTOs([
      { id: "current", label: "Current", isDefault: true, authState: "ready", revision: 3, accessToken: marker },
      { id: "legacy", label: "Legacy", isDefault: false, authState: "missing", refreshToken: marker },
      { id: "unsupported", label: "Unsupported", isDefault: false, authState: "unknown", apiKey: marker },
    ])
    const binding = bindingDTO({
      mode: "legacy",
      authMode: "api-key",
      source: "environment",
      accountID: "legacy",
      credential: marker,
    })
    const output = JSON.stringify({ accounts, binding })

    expect(accounts).toEqual([
      { id: "current", label: "Current", isDefault: true, authState: "ready", revision: 3 },
      { id: "legacy", label: "Legacy", isDefault: false, authState: "missing" },
    ])
    expect(binding).toEqual({ mode: "legacy", authMode: "api-key", source: "environment", accountID: "legacy" })
    expect(output).not.toContain(marker)
  })

  test("a default or only account is not an implicit session assignment", () => {
    const account = { id: "only", label: "Only", isDefault: true, authState: "ready" as const }

    expect(accountDTOs([account])).toEqual([account])
    expect(canAssignBinding("ready", undefined)).toBe(false)
    expect(canAssignBinding("ready", { mode: "unbound", reason: "profile-required" })).toBe(true)
  })

  test("repair eligibility is independent of missing credentials and target freezes before confirmation", () => {
    let active = "session-a"
    const target = sessionTarget(active, () => active)
    const binding = { mode: "profile" as const, profileID: "deleted", authMode: "chatgpt-oauth", source: "explicit" }

    expect(canRepair(binding, new Set())).toBe(true)
    expect(canRepair(binding, new Set(["deleted"]))).toBe(false)
    active = "session-b"
    expect(target.id).toBe("session-a")
    expect(target.isCurrent()).toBe(false)
  })
})
