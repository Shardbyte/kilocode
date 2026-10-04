import { check, foreignKey, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { Timestamps } from "../../database/schema.sql"

export type Secret = {
  access: string
  refresh: string
  expires: number
  accountID?: string
}

export const ProfileTable = sqliteTable(
  "kilo_provider_account",
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    auth_mode: text().notNull().$type<"chatgpt-oauth">(),
    label: text().notNull(),
    label_key: text().notNull(),
    remote_id: text(),
    ...Timestamps,
  },
  (table) => [
    check("kilo_provider_account_auth_mode_check", sql`${table.auth_mode} = 'chatgpt-oauth'`),
    uniqueIndex("kilo_provider_account_label_idx").on(table.provider, table.label_key),
    uniqueIndex("kilo_provider_account_remote_idx")
      .on(table.provider, table.auth_mode, table.remote_id)
      .where(sql`${table.remote_id} IS NOT NULL`),
    uniqueIndex("kilo_provider_account_context_idx").on(table.provider, table.auth_mode, table.id),
  ],
)

export const SecretTable = sqliteTable(
  "kilo_provider_account_credential",
  {
    account_id: text().primaryKey(),
    value: text({ mode: "json" }).$type<Secret>().notNull(),
    revision: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    check("kilo_provider_account_revision_check", sql`${table.revision} >= 0`),
    foreignKey({
      name: "kilo_provider_account_credential_account_fk",
      columns: [table.account_id],
      foreignColumns: [ProfileTable.id],
    }).onDelete("cascade"),
  ],
)

export const DefaultTable = sqliteTable(
  "kilo_provider_account_default",
  {
    provider: text().notNull(),
    auth_mode: text().notNull(),
    account_id: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.auth_mode] }),
    foreignKey({
      name: "kilo_provider_account_default_context_fk",
      columns: [table.provider, table.auth_mode, table.account_id],
      foreignColumns: [ProfileTable.provider, ProfileTable.auth_mode, ProfileTable.id],
    }).onDelete("cascade"),
  ],
)
