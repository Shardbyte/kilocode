import { expect, test } from "bun:test"
import { runCrash } from "./crash"

test("crash qualification refuses to claim interruption without an in-transaction barrier", () => {
  expect(runCrash()).toMatchObject([
    {
      id: "migration-crash:abrupt-during-migration",
      status: "NOT_RUN",
      evidence: "NOT_RUN",
      details: {
        killPoint: "unobservable without a migration barrier",
        recoveryAssertion: "not performed",
        publication: "no host database opened or modified",
      },
    },
  ])
})
