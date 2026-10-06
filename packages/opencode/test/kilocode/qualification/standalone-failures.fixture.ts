export const failures = [
  {
    name: "authorization 401",
    response: () => Response.json({ error: { message: "SECRET_PROVIDER_ERROR SECRET_ACCESS_A" } }, { status: 401 }),
  },
  {
    name: "quota 429",
    response: () =>
      Response.json(
        { error: { message: "SECRET_PROVIDER_ERROR SECRET_ACCESS_A", code: "FreeUsageLimitError" } },
        { status: 429 },
      ),
  },
  {
    name: "service 503 quota",
    response: () =>
      Response.json(
        { error: { message: "SECRET_PROVIDER_ERROR SECRET_ACCESS_A", code: "FreeUsageLimitError" } },
        { status: 503 },
      ),
  },
  {
    name: "malformed 400",
    response: () => new Response("{ SECRET_PROVIDER_ERROR SECRET_ACCESS_A", { status: 400 }),
  },
  {
    name: "timeout",
    reject: () => {
      throw new DOMException("request timed out SECRET_ACCESS_A", "TimeoutError")
    },
  },
  {
    name: "DNS nested cause",
    reject: () => {
      throw new Error("fetch failed SECRET_PROVIDER_ERROR", {
        cause: new Error("getaddrinfo ENOTFOUND api.example SECRET_ACCESS_A"),
      })
    },
  },
  {
    name: "refresh malformed token response",
    refresh: true,
  },
] as const

export const markers = [
  "SECRET_ACCESS_A",
  "SECRET_REFRESH_A",
  "SECRET_PROVIDER_ERROR",
  "SECRET_ENV_KEY",
  "SECRET_LEGACY_KEY",
  "SECRET_ACCOUNT_B",
]
