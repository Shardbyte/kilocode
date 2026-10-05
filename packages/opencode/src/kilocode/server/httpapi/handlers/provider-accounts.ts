// kilocode_change - guarded provider profile lifecycle HTTP API
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { makeOAuthFlow, OAuthOperationUnavailableError, type OAuthAdapter } from "@/kilocode/provider-account-oauth"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ProviderAccountApiError } from "../groups/provider-accounts"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import type { ProviderAccountProfiles as Profiles } from "@opencode-ai/core/kilocode/provider-account-profiles"

type Operation =
  | { label: string; targetID?: never; revision?: never }
  | { targetID: string; revision: number; label?: never }

type OAuthResult = Awaited<ReturnType<typeof import("@/plugin/openai/codex").completeCodexOAuth>>

const codexOAuth: OAuthAdapter<OAuthResult> = {
  start: async () => (await import("@/plugin/openai/codex")).startCodexOAuth(),
  complete: async (id: string) => (await import("@/plugin/openai/codex")).completeCodexOAuth(id),
  cancel: async (id: string) => (await import("@/plugin/openai/codex")).cancelCodexOAuth(id),
}
const PROVIDER = "openai"
const MODE = "chatgpt-oauth" as const

function failure(error: ProviderAccountApiError["error"], message: string) {
  return new ProviderAccountApiError({ error, message })
}

function mapError(err: unknown) {
  if (err instanceof ProviderAccountApiError) return err
  if (err instanceof ProviderAccountProfiles.AccountUnavailableError)
    return failure("NotFound", "Provider account is unavailable")
  if (err instanceof ProviderAccountProfiles.StaleCredentialError)
    return failure("Conflict", "Provider account changed; refresh and retry")
  if (err instanceof ProviderAccountProfiles.DuplicateRemoteIdentityError)
    return failure("Duplicate", "This remote account is already saved")
  if (err instanceof ProviderAccountProfiles.IdentityMismatchError)
    return failure("IdentityMismatch", "OAuth identity does not match this provider account")
  if (err instanceof ProviderAccountProfiles.CredentialStorageError)
    return failure("StorageFailed", "Provider account could not be stored")
  const tag = typeof err === "object" && err !== null && "_tag" in err ? String(err._tag) : ""
  if (tag.includes("NotFound")) return failure("NotFound", "Session was not found")
  if (tag.includes("Conflict")) return failure("Conflict", "Session provider binding cannot be changed")
  if (tag.includes("AccountUnavailable")) return failure("NotFound", "Session provider account is unavailable")
  return failure("StorageFailed", "Provider account operation failed")
}

function publicInfo(
  info: Profiles.Info,
  revision: number | undefined,
  value: Profiles.Secret | undefined,
  defaultID?: string,
) {
  return {
    id: info.id,
    provider: info.provider,
    authMode: info.authMode,
    label: info.label,
    ...(info.remoteID == null ? {} : { remoteID: info.remoteID }),
    timeCreated: info.timeCreated,
    timeUpdated: info.timeUpdated,
    isDefault: info.id === defaultID,
    ...(revision == null ? {} : { revision }),
    authState: secretState(value),
  }
}

function secretState(value: Profiles.Secret | undefined) {
  if (!value) return "missing" as const
  return value.expires > Date.now() ? ("ready" as const) : ("expired" as const)
}

function duplicate(items: Profiles.Info[], value: string, id?: string) {
  const key = value.trim().normalize("NFC").toLowerCase()
  return items.some((item) => item.id !== id && item.label.toLowerCase() === key)
}

export function makeProviderAccountsHandlers(adapter: OAuthAdapter<OAuthResult> = codexOAuth) {
  const oauth = makeOAuthFlow<OAuthResult, Operation>(adapter)
  return HttpApiBuilder.group(InstanceHttpApi, "provider-accounts", (handlers) =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const session = yield* Session.Service

      const guard = Effect.fn("ProviderAccountsHttpApi.guard")(function* () {
        if (!ProviderAccountProfiles.enabled())
          return yield* Effect.fail(failure("Disabled", "Provider profiles are disabled"))
      })

      const list = Effect.fn("ProviderAccountsHttpApi.list")(function* (ctx: { query: { provider: string } }) {
        yield* guard()
        if (ctx.query.provider !== PROVIDER)
          return yield* Effect.fail(failure("InvalidRequest", "Unsupported provider"))
        const [accounts, defaultID] = yield* Effect.all([
          profiles.list(PROVIDER, MODE),
          profiles.getDefault(PROVIDER, MODE),
        ])
        const rows = yield* Effect.forEach(accounts, (account) =>
          profiles
            .credential(account.id)
            .pipe(Effect.map((value) => publicInfo(account, value?.revision, value?.value, defaultID))),
        )
        return {
          accounts: rows,
          ...(defaultID == null ? {} : { defaultAccountID: defaultID }),
        }
      })

      const get = Effect.fn("ProviderAccountsHttpApi.get")(function* (ctx: { params: { accountID: string } }) {
        yield* guard()
        const account = yield* profiles.get(ctx.params.accountID)
        if (!account || account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        const [secret, defaultID] = yield* Effect.all([
          profiles.credential(account.id),
          profiles.getDefault(PROVIDER, MODE),
        ])
        return publicInfo(account, secret?.revision, secret?.value, defaultID)
      })

      const authState = Effect.fn("ProviderAccountsHttpApi.authState")(function* (ctx: {
        params: { accountID: string }
      }) {
        yield* guard()
        const account = yield* profiles.get(ctx.params.accountID)
        if (!account || account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        const value = yield* profiles.credential(account.id)
        return {
          accountID: account.id,
          state: secretState(value?.value),
          ...(value == null ? {} : { revision: value.revision }),
        }
      })

      const createOAuth = Effect.fn("ProviderAccountsHttpApi.createOAuth")(function* (ctx: {
        payload: { label: string }
      }) {
        yield* guard()
        if (!ctx.payload.label.trim())
          return yield* Effect.fail(failure("InvalidRequest", "Account label must not be empty"))
        const result = yield* Effect.tryPromise({
          try: () => oauth.start({ label: ctx.payload.label }),
          catch: () => failure("OAuthFailed", "Could not start provider OAuth"),
        })
        return result
      })

      const reauthOAuth = Effect.fn("ProviderAccountsHttpApi.reauthOAuth")(function* (ctx: {
        params: { accountID: string }
        payload: { expectedRevision: number }
      }) {
        yield* guard()
        const account = yield* profiles.get(ctx.params.accountID)
        const current = yield* profiles.credential(ctx.params.accountID)
        if (!account || !current) return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        if (account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("InvalidRequest", "Unsupported provider account"))
        if (current.revision !== ctx.payload.expectedRevision)
          return yield* Effect.fail(failure("Conflict", "Provider account changed; refresh and retry"))
        const result = yield* Effect.tryPromise({
          try: () => oauth.start({ targetID: ctx.params.accountID, revision: ctx.payload.expectedRevision }),
          catch: () => failure("OAuthFailed", "Could not start provider OAuth"),
        })
        return result
      })

      const completeOAuth = Effect.fn("ProviderAccountsHttpApi.completeOAuth")(function* (ctx: {
        payload: { operationID: string }
      }) {
        yield* guard()
        const result = yield* Effect.tryPromise({
          try: () => oauth.complete(ctx.payload.operationID),
          catch: (error) =>
            error instanceof OAuthOperationUnavailableError
              ? failure("NotFound", "OAuth operation was not found or has expired")
              : failure("OAuthFailed", "OAuth operation failed"),
        })
        const op = result.context
        const cred = result.result.credential
        if (!cred.accountID || !result.result.remoteID)
          return yield* Effect.fail(
            failure("IdentityMismatch", "OAuth did not provide a stable remote account identity"),
          )
        if (op.targetID === undefined) {
          const existing = yield* profiles.list(PROVIDER, MODE)
          if (existing.some((item) => item.remoteID === result.result.remoteID))
            return yield* Effect.fail(failure("Duplicate", "This remote account is already saved"))
          if (duplicate(existing, op.label))
            return yield* Effect.fail(failure("Duplicate", "An account with this label already exists"))
        }
        const info =
          op.targetID === undefined
            ? yield* profiles.create({
                provider: PROVIDER,
                authMode: MODE,
                label: op.label,
                remoteID: result.result.remoteID,
                credential: {
                  access: cred.access,
                  refresh: cred.refresh,
                  expires: cred.expires,
                  accountID: cred.accountID,
                },
              })
            : yield* profiles
                .reauthenticate({
                  id: op.targetID,
                  revision: op.revision,
                  remoteID: result.result.remoteID,
                  value: {
                    access: cred.access,
                    refresh: cred.refresh,
                    expires: cred.expires,
                    accountID: cred.accountID,
                  },
                })
                .pipe(Effect.flatMap(() => profiles.get(op.targetID)))
        if (!info) return yield* Effect.fail(failure("Conflict", "Provider account was removed during OAuth"))
        const current = yield* profiles.credential(info.id)
        if (!current) return yield* Effect.fail(failure("Conflict", "Provider account was removed during OAuth"))
        const defaultID = yield* profiles.getDefault(PROVIDER, MODE)
        return { account: publicInfo(info, current.revision, current.value, defaultID) }
      })

      const cancelOAuth = Effect.fn("ProviderAccountsHttpApi.cancelOAuth")(function* (ctx: {
        params: { operationID: string }
      }) {
        yield* guard()
        yield* Effect.tryPromise({
          try: () => oauth.cancel(ctx.params.operationID),
          catch: (error) =>
            error instanceof OAuthOperationUnavailableError
              ? failure("NotFound", "OAuth operation was not found or has expired")
              : failure("OAuthFailed", "OAuth operation could not be canceled"),
        })
        return true
      })

      const rename = Effect.fn("ProviderAccountsHttpApi.rename")(function* (ctx: {
        params: { accountID: string }
        payload: { label: string }
      }) {
        yield* guard()
        if (!ctx.payload.label.trim())
          return yield* Effect.fail(failure("InvalidRequest", "Account label must not be empty"))
        const account = yield* profiles.get(ctx.params.accountID)
        if (!account || account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        if (duplicate(yield* profiles.list(PROVIDER, MODE), ctx.payload.label, account.id))
          return yield* Effect.fail(failure("Duplicate", "An account with this label already exists"))
        const info = yield* profiles.rename(ctx.params.accountID, ctx.payload.label)
        const current = yield* profiles.credential(info.id)
        const defaultID = yield* profiles.getDefault(PROVIDER, MODE)
        if (!current) return yield* Effect.fail(failure("NotFound", "Provider account credential is unavailable"))
        return publicInfo(info, current.revision, current.value, defaultID)
      })

      const setDefault = Effect.fn("ProviderAccountsHttpApi.default")(function* (ctx: {
        params: { providerID: string }
        payload: { accountID: string }
      }) {
        yield* guard()
        if (ctx.params.providerID !== PROVIDER)
          return yield* Effect.fail(failure("InvalidRequest", "Unsupported provider"))
        const account = yield* profiles.get(ctx.payload.accountID)
        if (!account || account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        if (!(yield* profiles.credential(ctx.payload.accountID)))
          return yield* Effect.fail(failure("NotFound", "Provider account credential is unavailable"))
        yield* profiles.selectDefault(PROVIDER, MODE, ctx.payload.accountID)
        return true
      })

      const clearDefault = Effect.fn("ProviderAccountsHttpApi.clearDefault")(function* (ctx: {
        params: { providerID: string }
      }) {
        yield* guard()
        if (ctx.params.providerID !== PROVIDER)
          return yield* Effect.fail(failure("InvalidRequest", "Unsupported provider"))
        yield* profiles.clearDefault(PROVIDER, MODE)
        return true
      })

      const remove = Effect.fn("ProviderAccountsHttpApi.remove")(function* (ctx: { params: { accountID: string } }) {
        yield* guard()
        const account = yield* profiles.get(ctx.params.accountID)
        if (!account || account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        yield* profiles.remove(ctx.params.accountID)
        return true
      })

      const getBinding = Effect.fn("ProviderAccountsHttpApi.binding")(function* (ctx: {
        params: { sessionID: SessionID; providerID: ProviderV2.ID }
      }) {
        yield* guard()
        if (ctx.params.providerID !== PROVIDER)
          return yield* Effect.fail(failure("InvalidRequest", "Unsupported provider"))
        const binding = yield* session.binding(ctx.params.sessionID)
        return binding?.providers[PROVIDER] ?? null
      })

      const assignBinding = Effect.fn("ProviderAccountsHttpApi.assignBinding")(function* (ctx: {
        params: { sessionID: SessionID; providerID: ProviderV2.ID }
        payload: { accountID: string; confirmRepair?: boolean }
      }) {
        yield* guard()
        if (ctx.params.providerID !== PROVIDER)
          return yield* Effect.fail(failure("InvalidRequest", "Unsupported provider"))
        const account = yield* profiles.get(ctx.payload.accountID)
        if (!account || account.provider !== PROVIDER || account.authMode !== MODE)
          return yield* Effect.fail(failure("NotFound", "Provider account was not found"))
        if (!(yield* profiles.credential(ctx.payload.accountID)))
          return yield* Effect.fail(failure("NotFound", "Provider account credential is unavailable"))
        return yield* session.assignBinding({
          sessionID: ctx.params.sessionID,
          provider: PROVIDER,
          profileID: ctx.payload.accountID,
          confirmRepair: ctx.payload.confirmRepair,
        })
      })

      const handle = <A, E, R>(self: Effect.Effect<A, E, R>) =>
        self.pipe(
          Effect.mapError(mapError),
          Effect.catchDefect(() => Effect.fail(failure("StorageFailed", "Provider account operation failed"))),
        )

      return handlers
        .handle("list", (ctx) => handle(list(ctx)))
        .handle("get", (ctx) => handle(get(ctx)))
        .handle("authState", (ctx) => handle(authState(ctx)))
        .handle("createOAuth", (ctx) => handle(createOAuth(ctx)))
        .handle("reauthOAuth", (ctx) => handle(reauthOAuth(ctx)))
        .handle("completeOAuth", (ctx) => handle(completeOAuth(ctx)))
        .handle("cancelOAuth", (ctx) => handle(cancelOAuth(ctx)))
        .handle("rename", (ctx) => handle(rename(ctx)))
        .handle("default", (ctx) => handle(setDefault(ctx)))
        .handle("clearDefault", (ctx) => handle(clearDefault(ctx)))
        .handle("remove", (ctx) => handle(remove(ctx)))
        .handle("sessionBinding", (ctx) => handle(getBinding(ctx)))
        .handle("assignSession", (ctx) => handle(assignBinding(ctx)))
    }),
  )
}

export const providerAccountsHandlers = makeProviderAccountsHandlers()
