import * as prompts from "@clack/prompts"
import type { UtilityAccount } from "@/kilocode/provider/utility-account"

export type Account = { id: string; label: string }

export async function pick(input: {
  accounts: Account[]
  accountID?: string
  legacy: boolean
  interactive: boolean
}): Promise<Exclude<UtilityAccount.Context, { kind: "session" }>> {
  if (input.accountID && input.legacy) throw new Error("--account and --legacy-auth cannot be used together")
  if (input.accountID) {
    const account = input.accounts.find((item) => item.id === input.accountID)
    if (!account) throw new Error("The selected OpenAI account is unavailable")
    return { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: account.id }
  }
  if (input.legacy) return { kind: "legacy", providerID: "openai" }
  if (!input.interactive) throw new Error("OpenAI utility generation requires --account <id> or --legacy-auth")

  const options = [
    ...input.accounts.map((item) => ({ label: item.label, value: item.id })),
    { label: "Legacy OpenAI authentication", value: "legacy" },
  ]
  const value = await prompts.select({ message: "OpenAI authentication for this utility", options })
  if (prompts.isCancel(value)) throw new Error("OpenAI account selection cancelled")
  if (value === "legacy") return { kind: "legacy", providerID: "openai" }
  return { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: value }
}
