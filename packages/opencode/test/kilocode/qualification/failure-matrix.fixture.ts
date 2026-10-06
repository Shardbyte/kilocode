export const failures = [
  {
    name: "timeout",
    reject: () => {
      throw new DOMException("request timed out SECRET_ACCESS_A", "TimeoutError")
    },
  },
  {
    name: "DNS cause chain",
    reject: () => {
      const cause = new Error("getaddrinfo ENOTFOUND api.example SECRET_REFRESH_A")
      throw new Error("fetch failed SECRET_PROVIDER_ERROR", { cause })
    },
  },
  { name: "malformed 400 body", status: 400, raw: "{ SECRET_PROVIDER_ERROR SECRET_ACCESS_A" },
  {
    name: "quota 429",
    status: 429,
    body: { error: { message: "SECRET_PROVIDER_ERROR SECRET_ACCESS_A", code: "FreeUsageLimitError" } },
  },
  { name: "authorization 401", status: 401, body: { error: { message: "SECRET_PROVIDER_ERROR SECRET_REFRESH_A" } } },
  {
    name: "service 503 quota",
    status: 503,
    body: { error: { message: "SECRET_PROVIDER_ERROR SECRET_ENV_KEY", code: "FreeUsageLimitError" } },
  },
  {
    name: "refresh parser failure at credential transport boundary",
    refresh: true,
    raw: "not-json SECRET_REFRESH_A SECRET_PROVIDER_ERROR",
  },
] as const

export const markers = [
  "SECRET_ACCESS_A",
  "SECRET_REFRESH_A",
  "SECRET_PROVIDER_ERROR",
  "SECRET_ENV_KEY",
  "SECRET_AUTH_CONTENT",
  "SECRET_LEGACY_KEY",
  "SECRET_ACCOUNT_B",
]
