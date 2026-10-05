export type ProviderAccount = {
  id: string
  label: string
  isDefault: boolean
  revision?: number
  authState: "ready" | "expired" | "missing"
}

export type ProviderAccountBinding =
  | { mode: "unbound"; reason: "profile-required" | "missing-profile" | "legacy-migration-pending" }
  | { mode: "profile"; profileID: string; authMode: string; source: string }
  | { mode: "legacy"; authMode: string; source: string; accountID?: string }

export type ProviderAccountUsage = {
  accountID: string
  retrievedAt: string
  snapshot: {
    planLabel: string
    fetchState: string
    windows: Array<{
      id: string
      resource: string
      unit: string
      orientation: "used_percent" | "remaining_percent" | "amount" | "count"
      durationMs?: number
      used?: number
      remaining?: number
      limit?: number
      resetAt?: string
      state: string
    }>
  }
}

export type ProviderAccountsLoadedMessage = {
  type: "providerAccountsLoaded"
  accounts: ProviderAccount[]
  available: boolean
  sessionID?: string
  binding?: ProviderAccountBinding | null
  bindingStatus?: "ready" | "error" | "no-session"
  usage?: ProviderAccountUsage
  action?: string
  error?: string
}

export type ProviderAccountsRequest = {
  type: "providerAccounts"
  action: "list" | "add" | "rename" | "default" | "remove" | "reauth" | "usage" | "refreshUsage" | "binding" | "assign"
  id?: string
  label?: string
  revision?: number
  sessionID?: string
  confirmRepair?: boolean
}
