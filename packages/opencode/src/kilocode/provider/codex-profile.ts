import { Effect } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { extractAccountId, extractResidency, refreshAccessToken } from "@/plugin/openai/codex"
import { OpenAIWebSocketPool } from "@/plugin/openai/ws-pool"

const endpoint = "https://chatgpt.com/backend-api/codex/responses"
const api = "https://api.openai.com/v1/responses"
const token = "https://auth.openai.com/oauth/token"

type Auth = ProviderAccountProfiles.Secret
type Binding =
  | { mode: "profile"; profileID: string; authMode: string }
  | { mode: "legacy" }
  | { mode: "unbound"; reason: string }
export type UtilityAccountContext =
  | { kind: "session"; sourceSessionID: string }
  | { kind: "account"; providerID: "openai"; authMode: "chatgpt-oauth"; accountID: string }
  | { kind: "legacy"; providerID: string }
  | { kind: "branch-name"; sourceSessionID: string }
  | { kind: "commit-message" }

export function bindingSessionID(context: UtilityAccountContext | undefined, sessionID: string) {
  if (context?.kind === "branch-name" || context?.kind === "session") return context.sourceSessionID
  if (context?.kind === "commit-message" || context?.kind === "account" || context?.kind === "legacy") return undefined
  return sessionID
}
type Ports = {
  refresh: (id: string) => Promise<unknown>
  dispatch: <A>(
    id: string,
    transport: (auth: Auth, revision: number) => Promise<A>,
  ) => Promise<{ response: Promise<A> }>
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function expired(auth: Auth) {
  return !auth.access || auth.expires <= Date.now()
}

export function resolveBinding(binding: Binding | undefined, enabled: boolean, utility?: UtilityAccountContext) {
  if (utility?.kind === "commit-message") {
    if (enabled) throw new Error("This utility has no profile-bound session context")
    return { mode: "legacy" as const }
  }
  if (!binding) throw new Error("This session has no explicit OpenAI account binding")
  if (binding.mode === "unbound") throw new Error("This session requires an OpenAI account binding")
  if (binding.mode === "legacy") return { mode: "legacy" as const }
  if (!enabled) throw new Error("OpenAI account profiles are disabled; this session cannot use its bound account")
  if (binding.authMode !== "chatgpt-oauth")
    throw new Error("This session has an unsupported OpenAI account authentication mode")
  return { mode: "profile" as const, profileID: binding.profileID }
}

export async function refresh(
  id: string,
  profiles: ProviderAccountProfiles.Interface,
  request: Ports["request"] = globalThis.fetch,
) {
  return Effect.runPromise(
    profiles.withRefresh(
      id,
      Effect.gen(function* () {
        const info = yield* profiles.get(id)
        if (!info || info.provider !== "openai" || info.authMode !== "chatgpt-oauth")
          throw new Error("Provider account is unavailable")
        const current = yield* profiles.credential(id)
        if (!current) throw new Error("Provider account is unavailable")
        if (!expired(current.value)) return current
        const controller = new AbortController()
        const timer = setTimeout(
          () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
          30_000,
        )
        const tokens = yield* Effect.promise(async () => {
          try {
            const result = await Effect.runPromise(
              profiles.dispatch(id, (auth) =>
                refreshAccessToken(auth.refresh, undefined, controller.signal, (input, init) => {
                  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
                  if (url.href !== token) throw new Error("Codex refresh endpoint is not allowed")
                  return request(url, { ...init, redirect: "error" })
                }),
              ),
            )
            return await result.response
          } finally {
            clearTimeout(timer)
          }
        })
        const remoteID = extractAccountId(tokens) ?? info.remoteID ?? undefined
        const accountID = extractAccountId(tokens) ?? current.value.accountID ?? info.remoteID ?? undefined
        if (current.value.accountID && accountID !== current.value.accountID)
          throw new Error("Provider account identity changed during refresh")
        if (info.remoteID && remoteID !== info.remoteID)
          throw new Error("Provider account identity changed during refresh")
        const value = {
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ...(accountID && { accountID }),
        }
        yield* profiles.reauthenticate({ id, revision: current.revision, value, ...(remoteID && { remoteID }) })
        return { value, revision: current.revision + 1 }
      }),
    ),
  )
}

export function makeFetch(id: string, ports: Ports): typeof globalThis.fetch {
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
    const allowed =
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.href === api || parsed.href === endpoint)
    if (!allowed) throw new Error("Codex account profiles may only call the official Responses endpoint")
    await ports.refresh(id)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))

    const rewrite = parsed.href === api
    const url = rewrite ? new URL(endpoint) : parsed
    const result = await ports.dispatch(id, (auth) => {
      const sendHeaders = new Headers(headers)
      sendHeaders.set("authorization", `Bearer ${auth.access}`)
      sendHeaders.delete("ChatGPT-Account-Id")
      if (auth.accountID) sendHeaders.set("ChatGPT-Account-Id", auth.accountID)
      sendHeaders.delete("x-openai-internal-codex-residency")
      if (rewrite) {
        const residency = extractResidency(auth.access)
        if (residency) sendHeaders.set("x-openai-internal-codex-residency", residency)
      }
      return ports.request(
        url,
        OpenAIWebSocketPool.withoutInternalHeaders({
          ...init,
          body: init?.body,
          headers: sendHeaders,
          redirect: "error",
        }),
      )
    })
    return result.response
  }
  return Object.assign(send, { preconnect: globalThis.fetch.preconnect })
}

export function fetch(id: string, profiles: ProviderAccountProfiles.Interface): typeof globalThis.fetch {
  return makeFetch(id, {
    refresh: (key) => refresh(key, profiles),
    request: globalThis.fetch,
    dispatch: (key, transport) => Effect.runPromise(profiles.dispatch(key, transport)),
  })
}
