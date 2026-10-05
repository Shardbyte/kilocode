import * as vscode from "vscode"
import type { ProviderAccount } from "../../webview-ui/src/types/messages/provider-accounts"

export type UtilityAccountContext =
  | { kind: "account"; providerID: "openai"; authMode: "chatgpt-oauth"; accountID: string }
  | { kind: "legacy"; providerID: string }
  | { kind: "session"; sourceSessionID: string }
export type UtilityAccountSelection = Extract<UtilityAccountContext, { kind: "account" | "legacy" }>

export async function selectUtilityAccount(
  accounts: ProviderAccount[],
  allowed: string[],
  ui: Pick<typeof vscode.window, "showQuickPick" | "showErrorMessage"> = vscode.window,
): Promise<UtilityAccountSelection | undefined> {
  const picks: Array<vscode.QuickPickItem & { value: UtilityAccountSelection }> = []
  if (allowed.includes("account")) {
    for (const account of accounts) {
      if (account.authState !== "ready") continue
      picks.push({
        label: account.label,
        description: "OpenAI account",
        value: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: account.id },
      })
    }
  }
  if (allowed.includes("legacy")) {
    picks.push({ label: "Use legacy provider authentication", value: { kind: "legacy", providerID: "openai" } })
  }
  if (!picks.length) {
    void ui.showErrorMessage(
      "No eligible account authority is available. Add an OpenAI account or configure legacy provider authentication.",
    )
    return
  }
  return (await ui.showQuickPick(picks, { placeHolder: "Account for this generation" }))?.value
}
