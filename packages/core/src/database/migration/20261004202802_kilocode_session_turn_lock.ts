import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// kilocode_change - new file
export default {
  id: "20261004202802_kilocode_session_turn_lock",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`kilo_session_turn_lock\` (
          \`session_id\` text PRIMARY KEY,
          \`owner_pid\` integer NOT NULL,
          \`owner_host\` text NOT NULL,
          \`owner_token\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
