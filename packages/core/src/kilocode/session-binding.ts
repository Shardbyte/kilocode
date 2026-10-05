export * as SessionBinding from "./session-binding"

import { and, eq } from "drizzle-orm"
import os from "os"
import { randomUUID } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { TurnLockTable } from "./session-binding/sql"

/** A session-scoped, secret-free provider account selection. */
export const Entry = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("unbound"),
    reason: Schema.Literals(["profile-required", "missing-profile", "legacy-migration-pending"]),
  }),
  Schema.Struct({
    mode: Schema.Literal("profile"),
    profileID: Schema.String,
    authMode: Schema.String,
    source: Schema.Literals(["default", "explicit", "inherited", "repair", "migration"]),
  }),
  Schema.Struct({
    mode: Schema.Literal("legacy"),
    authMode: Schema.String,
    source: Schema.Literals(["explicit", "environment", "migration"]),
    accountID: Schema.optional(Schema.String),
  }),
])

export const Info = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Record(Schema.String, Entry),
})
export type Info = Schema.Schema.Type<typeof Info>
export type Entry = Schema.Schema.Type<typeof Entry>

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionBinding.ConflictError", {
  message: Schema.String,
}) {}

export class AccountUnavailableError extends Schema.TaggedErrorClass<AccountUnavailableError>()(
  "SessionBinding.AccountUnavailableError",
  { message: Schema.String },
) {}

export class TurnActiveError extends Schema.TaggedErrorClass<TurnActiveError>()("SessionBinding.TurnActiveError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly turn: <A, E, R>(sessionID: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TurnActiveError, R>
  readonly exclusive: <A, E, R>(sessionID: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TurnActiveError, R>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/SessionBinding") {}

const local = new WeakMap<object, Map<string, { token: string; count: number }>>()

function dead(pid: number, host: string) {
  if (host !== os.hostname()) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const holds = local.get(db) ?? new Map<string, { token: string; count: number }>()
    local.set(db, holds)

    const acquire = Effect.fn("SessionBinding.acquireTurn")(function* (sessionID: string) {
      const held = holds.get(sessionID)
      if (held) {
        held.count++
        return held.token
      }
      const token = randomUUID()
      const host = os.hostname()
      while (true) {
        const result = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const prior = yield* tx.select().from(TurnLockTable).where(eq(TurnLockTable.session_id, sessionID)).get()
              if (!prior) {
                yield* tx.insert(TurnLockTable).values({
                  session_id: sessionID,
                  owner_pid: process.pid,
                  owner_host: host,
                  owner_token: token,
                }).run()
                return "acquired" as const
              }
              if (dead(prior.owner_pid, prior.owner_host)) {
                yield* tx.delete(TurnLockTable).where(and(
                  eq(TurnLockTable.session_id, sessionID),
                  eq(TurnLockTable.owner_token, prior.owner_token),
                )).run()
                return "retry" as const
              }
              return "busy" as const
            }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)
        if (result === "busy") return yield* new TurnActiveError({ message: "A turn is active for this session" })
        if (result === "retry") {
          yield* Effect.sleep("10 millis")
          continue
        }
        holds.set(sessionID, { token, count: 1 })
        return token
      }
    })

    const release = (sessionID: string, token: string) =>
      Effect.gen(function* () {
        const held = holds.get(sessionID)
        if (!held || held.token !== token) return
        held.count--
        if (held.count > 0) return
        holds.delete(sessionID)
        yield* db.delete(TurnLockTable)
          .where(and(eq(TurnLockTable.session_id, sessionID), eq(TurnLockTable.owner_token, token)))
          .run()
          .pipe(Effect.orDie)
      })

    const exclusive = <A, E, R>(sessionID: string, work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (holds.has(sessionID)) return yield* new TurnActiveError({ message: "A turn is active for this session" })
          const token = randomUUID()
          const host = os.hostname()
          const ok = yield* db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const prior = yield* tx.select().from(TurnLockTable).where(eq(TurnLockTable.session_id, sessionID)).get()
                if (prior && !dead(prior.owner_pid, prior.owner_host)) return false
                if (prior) {
                  yield* tx.delete(TurnLockTable).where(and(
                    eq(TurnLockTable.session_id, sessionID),
                    eq(TurnLockTable.owner_token, prior.owner_token),
                  )).run()
                }
                yield* tx.insert(TurnLockTable).values({
                  session_id: sessionID,
                  owner_pid: process.pid,
                  owner_host: host,
                  owner_token: token,
                }).run()
                return true
              }),
            { behavior: "immediate" },
          ).pipe(Effect.orDie)
          if (!ok) return yield* new TurnActiveError({ message: "A turn is active for this session" })
          return token
        }),
        () => work,
        (token) => db.delete(TurnLockTable)
          .where(and(eq(TurnLockTable.session_id, sessionID), eq(TurnLockTable.owner_token, token)))
          .run()
          .pipe(Effect.orDie),
      )

    const turn = <A, E, R>(sessionID: string, work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(acquire(sessionID), (token) => work, (token) => release(sessionID, token))

    return Service.of({ turn, exclusive })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

const key = "providerBindings"

/** Return the persisted binding state without interpreting arbitrary metadata. */
export function get(metadata: Record<string, unknown> | undefined): Info | undefined {
  if (!metadata || typeof metadata.kilocode !== "object" || metadata.kilocode === null) return
  const value = (metadata.kilocode as Record<string, unknown>)[key]
  if (value === undefined) return
  return Schema.decodeUnknownSync(Info)(value)
}

/** Replace only the Kilo provider-binding metadata, preserving sibling Kilo metadata. */
export function set(metadata: Record<string, unknown> | undefined, info: Info): Record<string, unknown> {
  const kilo = metadata?.kilocode
  return {
    ...metadata,
    kilocode: {
      ...(typeof kilo === "object" && kilo !== null ? kilo : {}),
      [key]: info,
    },
  }
}

/** Preserve server-owned binding metadata across user-writable generic metadata updates. */
export function protect(current: Record<string, unknown> | undefined, incoming: Record<string, unknown>) {
  const binding = get(current)
  if (binding) return set(incoming, binding)
  const next = structuredClone(incoming)
  if (typeof next.kilocode !== "object" || next.kilocode === null) return next
  const kilo = { ...(next.kilocode as Record<string, unknown>) }
  delete kilo[key]
  if (Object.keys(kilo).length) next.kilocode = kilo
  else delete next.kilocode
  return next
}

export function copy(metadata: Record<string, unknown> | undefined) {
  return metadata ? structuredClone(metadata) : undefined
}

export function replace(input: {
  current: Info | undefined
  provider: string
  entry: Entry
  confirmRepair?: boolean
  available: boolean
  priorAvailable?: boolean
}): Info {
  const prior = input.current?.providers[input.provider]
  if (!input.available) throw new AccountUnavailableError({ message: "Provider account is unavailable" })
  if (prior?.mode === "profile") {
    if (input.priorAvailable !== false) throw new ConflictError({ message: "A healthy session provider binding cannot be replaced" })
    if (!input.confirmRepair) throw new ConflictError({ message: "Repairing an unavailable session provider binding requires confirmation" })
  }
  if (prior?.mode === "legacy") throw new ConflictError({ message: "An explicit legacy session binding cannot be replaced" })
  if (!prior) throw new ConflictError({ message: "Provider binding must be explicitly unbound before assignment" })
  return {
    version: 1,
    providers: { ...input.current?.providers, [input.provider]: input.entry },
  }
}
