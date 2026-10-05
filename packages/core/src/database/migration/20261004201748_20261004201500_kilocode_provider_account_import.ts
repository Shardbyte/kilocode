// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004201748_20261004201500_kilocode_provider_account_import",
  up(tx) {
    return Effect.gen(function* () {
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`kilo_provider_account_import\` (
          \`name\` text PRIMARY KEY,
          \`account_id\` text,
          \`time_completed\` integer NOT NULL
        );
      `)
      // kilocode_change end
    })
  },
} satisfies DatabaseMigration.Migration
