import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Process-owned session admission lease; ownership is never inferred from heartbeat age. */
export const TurnLockTable = sqliteTable("kilo_session_turn_lock", {
  session_id: text().primaryKey(),
  owner_pid: integer().notNull(),
  owner_host: text().notNull(),
  owner_token: text().notNull(),
})
