export * as ProviderAccountProfiles from "./provider-account-profiles"

import { and, asc, eq, ne } from "drizzle-orm"
import { randomUUID } from "crypto"
import os from "os"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import {
  DefaultTable,
  ImportTable,
  ProfileTable,
  RefreshLockTable,
  SecretTable,
  type Secret,
} from "./provider-account-profiles/sql"
import { ascending } from "@opencode-ai/schema/identifier"
import { enabled } from "./provider-account-profiles/coordination"
import { importStoredLegacy } from "./provider-account-profiles/lifecycle"
import { Credential } from "../credential"

export type { Secret } from "./provider-account-profiles/sql"

export type AuthMode = "chatgpt-oauth"

export type Info = {
  id: string
  provider: string
  authMode: AuthMode
  label: string
  remoteID: string | null
  timeCreated: number
  timeUpdated: number
}

export class StaleCredentialError extends Schema.TaggedErrorClass<StaleCredentialError>()(
  "ProviderAccountProfiles.StaleCredentialError",
  { message: Schema.String },
) {}

export class CredentialStorageError extends Schema.TaggedErrorClass<CredentialStorageError>()(
  "ProviderAccountProfiles.CredentialStorageError",
  { message: Schema.String },
) {}

export class DuplicateRemoteIdentityError extends Schema.TaggedErrorClass<DuplicateRemoteIdentityError>()(
  "ProviderAccountProfiles.DuplicateRemoteIdentityError",
  { message: Schema.String },
) {}

export class IdentityMismatchError extends Schema.TaggedErrorClass<IdentityMismatchError>()(
  "ProviderAccountProfiles.IdentityMismatchError",
  { message: Schema.String },
) {}

export class AccountUnavailableError extends Schema.TaggedErrorClass<AccountUnavailableError>()(
  "ProviderAccountProfiles.AccountUnavailableError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly create: (input: {
    readonly provider: string
    readonly authMode: AuthMode
    readonly label: string
    readonly remoteID?: string | null
    readonly credential: Secret
  }) => Effect.Effect<Info, CredentialStorageError>
  readonly rename: (
    id: string,
    label: string,
  ) => Effect.Effect<
    Info,
    | CredentialStorageError
    | AccountUnavailableError
    | DuplicateRemoteIdentityError
    | IdentityMismatchError
    | StaleCredentialError
  >
  readonly get: (id: string) => Effect.Effect<Info | undefined, unknown>
  readonly list: (provider: string, authMode: AuthMode) => Effect.Effect<Info[], unknown>
  readonly credential: (id: string) => Effect.Effect<{ value: Secret; revision: number } | undefined, unknown>
  readonly compareAndSwapCredential: (input: {
    readonly id: string
    readonly revision: number
    readonly value: Secret
  }) => Effect.Effect<number, CredentialStorageError | StaleCredentialError>
  readonly reauthenticate: (input: {
    readonly id: string
    readonly revision: number
    readonly value: Secret
    readonly remoteID?: string | null
  }) => Effect.Effect<
    number,
    | CredentialStorageError
    | StaleCredentialError
    | IdentityMismatchError
    | DuplicateRemoteIdentityError
    | AccountUnavailableError
  >
  readonly remove: (id: string) => Effect.Effect<void, unknown>
  readonly dispatch: <A>(
    id: string,
    transport: (credential: Secret, revision: number) => Promise<A>,
  ) => Effect.Effect<
    { response: Promise<A> },
    | AccountUnavailableError
    | CredentialStorageError
    | StaleCredentialError
    | IdentityMismatchError
    | DuplicateRemoteIdentityError
  >
  readonly withRefresh: <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AccountUnavailableError | CredentialStorageError, R>
  readonly importLegacy: (input: {
    readonly credential?: Secret
    readonly remoteID?: string
  }) => Effect.Effect<
    { imported: boolean; accountID?: string },
    | CredentialStorageError
    | AccountUnavailableError
    | DuplicateRemoteIdentityError
    | IdentityMismatchError
    | StaleCredentialError
  >
  readonly imported: () => Effect.Effect<{ completed: boolean; accountID?: string }, unknown>
  readonly selectDefault: (provider: string, authMode: AuthMode, id: string) => Effect.Effect<void, unknown>
  readonly getDefault: (provider: string, authMode: AuthMode) => Effect.Effect<string | undefined, unknown>
  readonly clearDefault: (provider: string, authMode: AuthMode) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/ProviderAccountProfiles") {}
export { enabled } from "./provider-account-profiles/coordination"

// Trim outer whitespace, normalize to NFC, then lowercase with JavaScript's locale-independent Unicode mapping.
// Internal whitespace stays intact; equal normalized keys are unique within a provider.
function label(value: string) {
  const name = value.trim().normalize("NFC")
  if (!name) throw new Error("Provider account label must not be empty")
  return { name, key: name.toLowerCase() }
}

const info = (row: typeof ProfileTable.$inferSelect): Info => ({
  id: row.id,
  provider: row.provider,
  authMode: row.auth_mode,
  label: row.label,
  remoteID: row.remote_id,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    type Known =
      | CredentialStorageError
      | StaleCredentialError
      | IdentityMismatchError
      | DuplicateRemoteIdentityError
      | AccountUnavailableError
    const safe = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, Known> =>
      Effect.catchCause(effect, (cause): Effect.Effect<never, Known> => {
        const failure = Cause.squash(cause)
        if (
          failure instanceof StaleCredentialError ||
          failure instanceof IdentityMismatchError ||
          failure instanceof DuplicateRemoteIdentityError ||
          failure instanceof AccountUnavailableError
        )
          return Effect.fail(failure as Known)
        return Effect.fail(new CredentialStorageError({ message: "Provider account operation could not be completed" }))
      })

    return Service.of({
      create: Effect.fn("ProviderAccountProfiles.create")(function* (input) {
        const id = `pacc_${ascending()}`
        const now = Date.now()
        const name = label(input.label)
        const remoteID = input.remoteID ?? null
        const result = {
          id,
          provider: input.provider,
          authMode: input.authMode,
          label: name.name,
          remoteID,
          timeCreated: now,
          timeUpdated: now,
        } satisfies Info

        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const prior = yield* tx
                  .select({ id: ProfileTable.id })
                  .from(ProfileTable)
                  .where(and(eq(ProfileTable.provider, input.provider), eq(ProfileTable.auth_mode, input.authMode)))
                  .get()
                yield* tx
                  .insert(ProfileTable)
                  .values({
                    id,
                    provider: input.provider,
                    auth_mode: input.authMode,
                    label: name.name,
                    label_key: name.key,
                    remote_id: remoteID,
                    time_created: now,
                    time_updated: now,
                  })
                  .run()
                yield* tx
                  .insert(SecretTable)
                  .values({ account_id: id, value: input.credential, revision: 0, time_updated: now })
                  .run()
                if (!prior) {
                  yield* tx
                    .insert(DefaultTable)
                    .values({ provider: input.provider, auth_mode: input.authMode, account_id: id })
                    .run()
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.catchCause(() =>
              Effect.fail(new CredentialStorageError({ message: "Provider account could not be stored" })),
            ),
          )
        return result
      }),
      rename: Effect.fn("ProviderAccountProfiles.rename")(function* (id, value) {
        const name = label(value)
        const row = yield* safe(
          db
            .update(ProfileTable)
            .set({ label: name.name, label_key: name.key, time_updated: Date.now() })
            .where(eq(ProfileTable.id, id))
            .returning()
            .get(),
        )
        if (!row) return yield* new AccountUnavailableError({ message: "Provider account is unavailable" })
        return info(row)
      }),
      get: Effect.fn("ProviderAccountProfiles.get")(function* (id) {
        const row = yield* db.select().from(ProfileTable).where(eq(ProfileTable.id, id)).get()
        return row ? info(row) : undefined
      }),
      list: Effect.fn("ProviderAccountProfiles.list")(function* (provider, authMode) {
        return (yield* db
          .select()
          .from(ProfileTable)
          .where(and(eq(ProfileTable.provider, provider), eq(ProfileTable.auth_mode, authMode)))
          .orderBy(asc(ProfileTable.time_created))
          .all()).map(info)
      }),
      credential: Effect.fn("ProviderAccountProfiles.credential")(function* (id) {
        const row = yield* db.select().from(SecretTable).where(eq(SecretTable.account_id, id)).get()
        return row ? { value: row.value, revision: row.revision } : undefined
      }),
      compareAndSwapCredential: Effect.fn("ProviderAccountProfiles.compareAndSwapCredential")(function* (input) {
        const row = yield* db
          .update(SecretTable)
          .set({ value: input.value, revision: input.revision + 1, time_updated: Date.now() })
          .where(and(eq(SecretTable.account_id, input.id), eq(SecretTable.revision, input.revision)))
          .returning({ revision: SecretTable.revision })
          .get()
          .pipe(
            Effect.catchCause(() =>
              Effect.fail(new CredentialStorageError({ message: "Provider account credential could not be stored" })),
            ),
          )
        if (!row) return yield* new StaleCredentialError({ message: "Provider account credential revision is stale" })
        return row.revision
      }),
      reauthenticate: Effect.fn("ProviderAccountProfiles.reauthenticate")(function* (input) {
        return yield* safe(
          db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const profile = yield* tx.select().from(ProfileTable).where(eq(ProfileTable.id, input.id)).get()
                if (!profile) return yield* new AccountUnavailableError({ message: "Provider account is unavailable" })
                const remoteID = input.remoteID ?? null
                if (profile.remote_id && profile.remote_id !== remoteID)
                  return yield* new IdentityMismatchError({
                    message: "Reauthentication returned a different account identity",
                  })
                if (remoteID) {
                  const duplicate = yield* tx
                    .select({ id: ProfileTable.id })
                    .from(ProfileTable)
                    .where(
                      and(
                        eq(ProfileTable.provider, profile.provider),
                        eq(ProfileTable.auth_mode, profile.auth_mode),
                        eq(ProfileTable.remote_id, remoteID),
                        ne(ProfileTable.id, input.id),
                      ),
                    )
                    .get()
                  if (duplicate)
                    return yield* new DuplicateRemoteIdentityError({
                      message: "That ChatGPT account is already connected",
                    })
                }
                const row = yield* tx
                  .update(SecretTable)
                  .set({ value: input.value, revision: input.revision + 1, time_updated: Date.now() })
                  .where(and(eq(SecretTable.account_id, input.id), eq(SecretTable.revision, input.revision)))
                  .returning({ revision: SecretTable.revision })
                  .get()
                if (!row)
                  return yield* new StaleCredentialError({ message: "Provider account credential revision is stale" })
                if (!profile.remote_id && remoteID)
                  yield* tx
                    .update(ProfileTable)
                    .set({ remote_id: remoteID, time_updated: Date.now() })
                    .where(eq(ProfileTable.id, input.id))
                    .run()
                return row.revision
              }),
            { behavior: "immediate" },
          ),
        )
      }),
      remove: Effect.fn("ProviderAccountProfiles.remove")(function* (id) {
        yield* db.delete(ProfileTable).where(eq(ProfileTable.id, id)).run().pipe(Effect.orDie)
      }),
      dispatch: Effect.fn("ProviderAccountProfiles.dispatch")(function* (id, transport) {
        return yield* safe(
          db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const profile = yield* tx
                  .select({ id: ProfileTable.id })
                  .from(ProfileTable)
                  .where(eq(ProfileTable.id, id))
                  .get()
                const secret = yield* tx.select().from(SecretTable).where(eq(SecretTable.account_id, id)).get()
                if (!profile || !secret)
                  return yield* new AccountUnavailableError({ message: "Provider account is unavailable" })
                const response = yield* Effect.try({
                  try: () => transport(secret.value, secret.revision),
                  catch: () =>
                    new AccountUnavailableError({ message: "Provider account request could not be started" }),
                })
                return { response }
              }),
            { behavior: "immediate" },
          ),
        )
      }),
      withRefresh: Effect.fn("ProviderAccountProfiles.withRefresh")(function* <A, E, R>(
        id: string,
        effect: Effect.Effect<A, E, R>,
      ) {
        const live = yield* db
          .select({ id: ProfileTable.id })
          .from(ProfileTable)
          .where(eq(ProfileTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (!live) return yield* new AccountUnavailableError({ message: "Provider account is unavailable" })
        const token = randomUUID()
        const host = os.hostname()
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            while (true) {
              const acquired = yield* db
                .transaction(
                  (tx) =>
                    Effect.gen(function* () {
                      const prior = yield* tx
                        .select()
                        .from(RefreshLockTable)
                        .where(eq(RefreshLockTable.account_id, id))
                        .get()
                      if (!prior) {
                        yield* tx
                          .insert(RefreshLockTable)
                          .values({
                            account_id: id,
                            owner_pid: process.pid,
                            owner_host: host,
                            owner_token: token,
                          })
                          .run()
                        return true
                      }
                      let dead = false
                      if (prior.owner_host === host) {
                        try {
                          process.kill(prior.owner_pid, 0)
                        } catch (error) {
                          dead =
                            typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
                        }
                      }
                      if (!dead) return false
                      yield* tx
                        .delete(RefreshLockTable)
                        .where(
                          and(eq(RefreshLockTable.account_id, id), eq(RefreshLockTable.owner_token, prior.owner_token)),
                        )
                        .run()
                      return false
                    }),
                  { behavior: "immediate" },
                )
                .pipe(
                  Effect.mapError(
                    () => new CredentialStorageError({ message: "Provider account lock could not be acquired" }),
                  ),
                )
              if (acquired) return token
              yield* Effect.sleep(50)
            }
          }),
          () =>
            Effect.gen(function* () {
              const current = yield* db
                .select({ id: ProfileTable.id })
                .from(ProfileTable)
                .where(eq(ProfileTable.id, id))
                .get()
                .pipe(Effect.orDie)
              if (!current) return yield* new AccountUnavailableError({ message: "Provider account is unavailable" })
              return yield* effect
            }),
          (owner) =>
            db
              .delete(RefreshLockTable)
              .where(and(eq(RefreshLockTable.account_id, id), eq(RefreshLockTable.owner_token, owner)))
              .run()
              .pipe(Effect.orDie),
        )
      }),
      importLegacy: Effect.fn("ProviderAccountProfiles.importLegacy")(function* (input) {
        if (!enabled()) return { imported: false }
        return yield* safe(
          db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const prior = yield* tx.select().from(ImportTable).where(eq(ImportTable.name, "chatgpt-oauth-v1")).get()
                if (prior) return { imported: false, ...(prior.account_id ? { accountID: prior.account_id } : {}) }
                const remoteID = input.remoteID || null
                const existing = remoteID
                  ? yield* tx
                      .select({ id: ProfileTable.id })
                      .from(ProfileTable)
                      .where(
                        and(
                          eq(ProfileTable.provider, "openai"),
                          eq(ProfileTable.auth_mode, "chatgpt-oauth"),
                          eq(ProfileTable.remote_id, remoteID),
                        ),
                      )
                      .get()
                  : undefined
                const id = existing?.id ?? (input.credential ? `pacc_${ascending()}` : undefined)
                if (id && input.credential && !existing) {
                  const now = Date.now()
                  const name = label("Imported ChatGPT")
                  yield* tx
                    .insert(ProfileTable)
                    .values({
                      id,
                      provider: "openai",
                      auth_mode: "chatgpt-oauth",
                      label: name.name,
                      label_key: name.key,
                      remote_id: remoteID,
                      time_created: now,
                      time_updated: now,
                    })
                    .run()
                  yield* tx
                    .insert(SecretTable)
                    .values({ account_id: id, value: input.credential, revision: 0, time_updated: now })
                    .run()
                  const priorDefault = yield* tx
                    .select({ id: DefaultTable.account_id })
                    .from(DefaultTable)
                    .where(and(eq(DefaultTable.provider, "openai"), eq(DefaultTable.auth_mode, "chatgpt-oauth")))
                    .get()
                  if (!priorDefault)
                    yield* tx
                      .insert(DefaultTable)
                      .values({ provider: "openai", auth_mode: "chatgpt-oauth", account_id: id })
                      .run()
                }
                yield* tx
                  .insert(ImportTable)
                  .values({ name: "chatgpt-oauth-v1", account_id: id ?? null, time_completed: Date.now() })
                  .run()
                return { imported: !!id && !!input.credential, ...(id ? { accountID: id } : {}) }
              }),
            { behavior: "immediate" },
          ),
        )
      }),
      imported: Effect.fn("ProviderAccountProfiles.imported")(function* () {
        const row = yield* db.select().from(ImportTable).where(eq(ImportTable.name, "chatgpt-oauth-v1")).get()
        return { completed: !!row, ...(row?.account_id ? { accountID: row.account_id } : {}) }
      }),
      selectDefault: Effect.fn("ProviderAccountProfiles.selectDefault")(function* (provider, authMode, id) {
        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const target = yield* tx
                .select({ id: ProfileTable.id })
                .from(ProfileTable)
                .where(
                  and(
                    eq(ProfileTable.id, id),
                    eq(ProfileTable.provider, provider),
                    eq(ProfileTable.auth_mode, authMode),
                  ),
                )
                .get()
              if (!target) throw new Error("Provider account does not belong to the requested provider/auth mode")
              yield* tx
                .insert(DefaultTable)
                .values({ provider, auth_mode: authMode, account_id: id })
                .onConflictDoUpdate({
                  target: [DefaultTable.provider, DefaultTable.auth_mode],
                  set: { account_id: id },
                })
                .run()
            }),
          { behavior: "immediate" },
        )
      }),
      getDefault: Effect.fn("ProviderAccountProfiles.getDefault")(function* (provider, authMode) {
        const row = yield* db
          .select({ id: DefaultTable.account_id })
          .from(DefaultTable)
          .where(and(eq(DefaultTable.provider, provider), eq(DefaultTable.auth_mode, authMode)))
          .get()
        return row?.id
      }),
      clearDefault: Effect.fn("ProviderAccountProfiles.clearDefault")(function* (provider, authMode) {
        yield* db
          .delete(DefaultTable)
          .where(and(eq(DefaultTable.provider, provider), eq(DefaultTable.auth_mode, authMode)))
          .run()
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

const activationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!enabled()) return
    const profiles = yield* Service
    const credentials = yield* Credential.Service
    yield* importStoredLegacy(profiles, credentials)
  }),
)

export const activation = makeGlobalNode({
  service: Service,
  layer: activationLayer.pipe(Layer.provideMerge(layer)),
  deps: [Database.node, Credential.node],
})
