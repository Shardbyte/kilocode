// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004191100_kilocode_provider_account_profiles",
  up(tx) {
    return Effect.gen(function* () {
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`kilo_provider_account_default\` (
          \`provider\` text NOT NULL,
          \`auth_mode\` text NOT NULL,
          \`account_id\` text NOT NULL,
          CONSTRAINT \`kilo_provider_account_default_pk\` PRIMARY KEY(\`provider\`, \`auth_mode\`),
          CONSTRAINT \`kilo_provider_account_default_context_fk\` FOREIGN KEY (\`provider\`,\`auth_mode\`,\`account_id\`) REFERENCES \`kilo_provider_account\`(\`provider\`,\`auth_mode\`,\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`kilo_provider_account\` (
          \`id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`auth_mode\` text NOT NULL,
          \`label\` text NOT NULL,
          \`label_key\` text NOT NULL,
          \`remote_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT "kilo_provider_account_auth_mode_check" CHECK("auth_mode" = 'chatgpt-oauth')
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`kilo_provider_account_credential\` (
          \`account_id\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`kilo_provider_account_credential_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`kilo_provider_account\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "kilo_provider_account_revision_check" CHECK("revision" >= 0)
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`kilo_provider_account_label_idx\` ON \`kilo_provider_account\` (\`provider\`,\`label_key\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`kilo_provider_account_remote_idx\` ON \`kilo_provider_account\` (\`provider\`,\`auth_mode\`,\`remote_id\`) WHERE "kilo_provider_account"."remote_id" IS NOT NULL;`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`kilo_provider_account_context_idx\` ON \`kilo_provider_account\` (\`provider\`,\`auth_mode\`,\`id\`);`,
      )
      // kilocode_change end
    })
  },
} satisfies DatabaseMigration.Migration
