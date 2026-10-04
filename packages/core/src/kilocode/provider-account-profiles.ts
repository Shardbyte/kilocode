export * as ProviderAccountProfiles from "./provider-account-profiles"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import { DefaultTable, ProfileTable, SecretTable, type Secret } from "./provider-account-profiles/sql"
import { ascending } from "@opencode-ai/schema/identifier"

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

export interface Interface {
  readonly create: (input: {
    readonly provider: string
    readonly authMode: AuthMode
    readonly label: string
    readonly remoteID?: string | null
    readonly credential: Secret
  }) => Effect.Effect<Info, CredentialStorageError>
  readonly get: (id: string) => Effect.Effect<Info | undefined, unknown>
  readonly list: (provider: string, authMode: AuthMode) => Effect.Effect<Info[], unknown>
  readonly credential: (id: string) => Effect.Effect<{ value: Secret; revision: number } | undefined, unknown>
  readonly compareAndSwapCredential: (input: {
    readonly id: string
    readonly revision: number
    readonly value: Secret
  }) => Effect.Effect<number, CredentialStorageError | StaleCredentialError>
  readonly selectDefault: (provider: string, authMode: AuthMode, id: string) => Effect.Effect<void, unknown>
  readonly getDefault: (provider: string, authMode: AuthMode) => Effect.Effect<string | undefined, unknown>
  readonly clearDefault: (provider: string, authMode: AuthMode) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/ProviderAccountProfiles") {}

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
