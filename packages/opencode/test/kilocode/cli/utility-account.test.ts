import { describe, expect, test } from "bun:test"
import { pick } from "../../../src/kilocode/cli/utility-account"

describe("utility account picker", () => {
  const accounts = [
    { id: "pacc_one", label: "Work" },
    { id: "pacc_two", label: "Personal" },
  ]

  test("requires an explicit account in non-interactive mode", async () => {
    await expect(pick({ accounts, legacy: false, interactive: false })).rejects.toThrow(
      "OpenAI utility generation requires --account <id> or --legacy-auth",
    )
  })

  test("resolves only the explicitly named account", async () => {
    await expect(pick({ accounts, accountID: "pacc_two", legacy: false, interactive: false })).resolves.toEqual({
      kind: "account",
      providerID: "openai",
      authMode: "chatgpt-oauth",
      accountID: "pacc_two",
    })
  })

  test("selects legacy authority only when requested", async () => {
    await expect(pick({ accounts, legacy: true, interactive: false })).resolves.toEqual({
      kind: "legacy",
      providerID: "openai",
    })
  })

  test("rejects conflicting or unavailable account arguments", async () => {
    await expect(pick({ accounts, accountID: "pacc_one", legacy: true, interactive: false })).rejects.toThrow(
      "--account and --legacy-auth cannot be used together",
    )
    await expect(pick({ accounts, accountID: "missing", legacy: false, interactive: false })).rejects.toThrow(
      "The selected OpenAI account is unavailable",
    )
  })
})
