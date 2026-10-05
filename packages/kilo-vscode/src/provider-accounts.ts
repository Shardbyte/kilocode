import type {
  ProviderAccount,
  ProviderAccountBinding,
  ProviderAccountUsage,
} from "../webview-ui/src/types/messages/provider-accounts"

export function canRepair(binding: ProviderAccountBinding | null | undefined, ids: ReadonlySet<string>) {
  return binding?.mode === "profile" && !ids.has(binding.profileID)
}

export function canAssignBinding(
  state: "loading" | "ready" | "error" | "no-session",
  binding: ProviderAccountBinding | null | undefined,
) {
  return state === "ready" && (binding === null || binding?.mode === "unbound")
}

export function safeAccountError(error: unknown) {
  if (!error || typeof error !== "object") return undefined
  const value = "error" in error ? error.error : undefined
  if (value === "Disabled") return undefined
  if (value === "Conflict")
    return "The provider account changed or this session has an active turn. Refresh and retry when the session is idle."
  if (value === "NotFound") return "The provider account or session is no longer available. Refresh and retry."
  if (value === "Duplicate") return "An account with that label or remote identity already exists."
  if (value === "InvalidRequest") return "The requested provider account operation is not valid."
  if (value === "IdentityMismatch")
    return "Reauthentication returned a different remote account. This profile was not changed."
  if (value === "OAuthFailed") return "OAuth did not complete. The account was not updated."
  if (value === "StorageFailed") return "Provider account storage is unavailable. Retry later."
  return "Provider account operation failed. Refresh and retry."
}

export function authorizationURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/oauth/authorize"
  )
    return undefined
  if (["access_token", "refresh_token", "token", "cookie"].some((key) => url.searchParams.has(key))) return undefined
  return url.href
}

export function sessionTarget(id: string | undefined, current: () => string | undefined) {
  return {
    id,
    isCurrent: () => id != null && current() === id,
  }
}

export function isCurrentSessionResponse(id: string | undefined, current: string | undefined) {
  return id === current
}

export function reauthRevision(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function accountDTO(value: unknown): ProviderAccount | undefined {
  if (!value || typeof value !== "object") return undefined
  if (!("id" in value) || typeof value.id !== "string") return undefined
  if (!("label" in value) || typeof value.label !== "string") return undefined
  if (!("isDefault" in value) || typeof value.isDefault !== "boolean") return undefined
  if (
    !("authState" in value) ||
    (value.authState !== "ready" && value.authState !== "expired" && value.authState !== "missing")
  )
    return undefined
  return {
    id: value.id,
    label: value.label,
    isDefault: value.isDefault,
    authState: value.authState,
    ...("revision" in value && typeof value.revision === "number" ? { revision: value.revision } : {}),
  }
}

export function accountDTOs(value: unknown): ProviderAccount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const dto = accountDTO(item)
    return dto ? [dto] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function unboundDTO(value: Record<string, unknown>): ProviderAccountBinding | undefined {
  const reason = value.reason
  if (reason === "profile-required" || reason === "missing-profile" || reason === "legacy-migration-pending")
    return { mode: "unbound", reason }
  return undefined
}

function profileDTO(value: Record<string, unknown>): ProviderAccountBinding | undefined {
  if (typeof value.profileID !== "string" || typeof value.authMode !== "string" || typeof value.source !== "string")
    return undefined
  return { mode: "profile", profileID: value.profileID, authMode: value.authMode, source: value.source }
}

function legacyDTO(value: Record<string, unknown>): ProviderAccountBinding | undefined {
  if (typeof value.authMode !== "string" || typeof value.source !== "string") return undefined
  return {
    mode: "legacy",
    authMode: value.authMode,
    source: value.source,
    ...(typeof value.accountID === "string" ? { accountID: value.accountID } : {}),
  }
}

export function bindingDTO(value: unknown): ProviderAccountBinding | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (value.mode === "unbound") return unboundDTO(value)
  if (value.mode === "profile") return profileDTO(value)
  if (value.mode === "legacy") return legacyDTO(value)
  return undefined
}

export function usageDTO(value: unknown): ProviderAccountUsage | undefined {
  if (!value || typeof value !== "object" || !("accountID" in value) || typeof value.accountID !== "string")
    return undefined
  if (!("retrievedAt" in value) || typeof value.retrievedAt !== "string") return undefined
  if (!("snapshot" in value) || !value.snapshot || typeof value.snapshot !== "object") return undefined
  const snap = value.snapshot
  if (!("planLabel" in snap) || typeof snap.planLabel !== "string") return undefined
  if (!("fetchState" in snap) || typeof snap.fetchState !== "string") return undefined
  const windows = "windows" in snap && Array.isArray(snap.windows) ? snap.windows : []
  return {
    accountID: value.accountID,
    retrievedAt: value.retrievedAt,
    snapshot: {
      planLabel: snap.planLabel,
      fetchState: snap.fetchState,
      windows: windows.flatMap((item) => {
        if (!isRecord(item)) return []
        if (
          typeof item.id !== "string" ||
          typeof item.resource !== "string" ||
          typeof item.state !== "string" ||
          typeof item.unit !== "string"
        )
          return []
        const orientation = (["used_percent", "remaining_percent", "amount", "count"] as const).find(
          (value) => item.orientation === value,
        )
        if (!orientation) return []
        return [
          {
            id: item.id,
            resource: item.resource,
            state: item.state,
            unit: item.unit,
            orientation,
            ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
            ...(typeof item.used === "number" ? { used: item.used } : {}),
            ...(typeof item.remaining === "number" ? { remaining: item.remaining } : {}),
            ...(typeof item.limit === "number" ? { limit: item.limit } : {}),
            ...(typeof item.resetAt === "string" ? { resetAt: item.resetAt } : {}),
          },
        ]
      }),
    },
  }
}
