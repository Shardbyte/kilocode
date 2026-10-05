// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004202311_20261004202100_kilocode_provider_account_refresh_lock",
  up(tx) {
    return Effect.gen(function* () {
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`kilo_provider_account_refresh_lock\` (
          \`account_id\` text PRIMARY KEY,
          \`owner_pid\` integer NOT NULL,
          \`owner_host\` text NOT NULL,
          \`owner_token\` text NOT NULL
        );
      `)
      // kilocode_change end
    })
  },
} satisfies DatabaseMigration.Migration
