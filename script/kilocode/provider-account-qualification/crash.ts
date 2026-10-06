import type { Item } from "./evidence"

/**
 * No supported qualification barrier exists inside DatabaseMigration.apply's
 * transaction. Killing after startup/exit would only test a completed migration,
 * so this deliberately reports NOT_RUN instead of claiming interruption evidence.
 */
export function runCrash() {
  return [
    {
      id: "migration-crash:abrupt-during-migration",
      status: "NOT_RUN",
      evidence: "NOT_RUN",
      reason:
        "No deterministic pre-commit migration barrier is exposed; the production migration runs its migration body and journal insert inside one transaction, and adding a production test hook is outside qualification scope",
      details: {
        transaction: "DatabaseMigration.applyOnly -> db.transaction(..., { behavior: 'immediate' })",
        killPoint: "unobservable without a migration barrier",
        recoveryAssertion: "not performed",
        publication: "no host database opened or modified",
      },
    },
  ] satisfies Item[]
}

if (import.meta.main) {
  const out = process.env.QUALIFICATION_EVIDENCE
  if (!out) throw new Error("QUALIFICATION_EVIDENCE is required")
  const { save } = await import("./evidence")
  await save(out, runCrash())
}
