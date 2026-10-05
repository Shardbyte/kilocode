import { beforeEach, describe, expect, it, mock } from "bun:test"

const pick = mock(async (_items: unknown[]) => undefined as unknown)
const error = mock((_message: string) => undefined)
const { selectUtilityAccount } = await import("../../src/services/utility-account")

describe("utility account selection", () => {
  beforeEach(() => {
    pick.mockClear()
    error.mockClear()
    pick.mockImplementation(async () => undefined)
  })

  it("offers ready profiles and explicit legacy authentication without credentials", async () => {
    pick.mockImplementation(async (items) => items[0])
    const context = await selectUtilityAccount(
      [
        { id: "ready-id", label: "Personal", isDefault: true, authState: "ready" },
        { id: "expired-id", label: "Expired", isDefault: false, authState: "expired" },
      ],
      ["account", "legacy"],
      { showQuickPick: pick as never, showErrorMessage: error as never },
    )

    expect(context).toEqual({ kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "ready-id" })
    expect(pick.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ label: "Personal", value: context }),
      expect.objectContaining({
        label: "Use legacy provider authentication",
        value: { kind: "legacy", providerID: "openai" },
      }),
    ])
    expect(JSON.stringify(pick.mock.calls[0]?.[0])).not.toContain("accessToken")
  })

  it("returns without authority when the user cancels", async () => {
    pick.mockResolvedValue(undefined)
    await expect(
      selectUtilityAccount([{ id: "ready-id", label: "Personal", isDefault: true, authState: "ready" }], ["account"], {
        showQuickPick: pick as never,
        showErrorMessage: error as never,
      }),
    ).resolves.toBeUndefined()
  })

  it("does not select an ineligible profile automatically", async () => {
    await expect(
      selectUtilityAccount(
        [{ id: "expired-id", label: "Expired", isDefault: false, authState: "expired" }],
        ["account"],
        { showQuickPick: pick as never, showErrorMessage: error as never },
      ),
    ).resolves.toBeUndefined()
    expect(pick).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining("No eligible account authority"))
  })
})
