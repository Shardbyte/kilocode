import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { Effect } from "effect"

// Availability is read-only: it neither resolves a default nor assigns a session binding.
// Expired access tokens remain usable when the exact profile can refresh itself.
export const eligible = Effect.fn("ProviderAvailability.eligible")(function* (
  profiles: ProviderAccountProfiles.Interface,
) {
  if (!ProviderAccountProfiles.enabled()) return false
  const accounts = yield* profiles.list("openai", "chatgpt-oauth")
  for (const account of accounts) {
    const credential = yield* profiles.credential(account.id)
    const value = credential?.value
    if (!value?.accountID || (account.remoteID && account.remoteID !== value.accountID)) continue
    if ((value.access && value.expires > Date.now()) || value.refresh) return true
  }
  return false
})
