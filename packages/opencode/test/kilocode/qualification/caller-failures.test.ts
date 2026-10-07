import { expect, test } from "bun:test"
import path from "node:path"

test("Agent.generate and roll-call fail safely for real SDK errors and captured production output", async () => {
  const root = path.resolve(import.meta.dir, "../../..")
  const child = Bun.spawn([process.execPath, "run", "test/kilocode/qualification/caller-failures.fixture.ts"], {
    cwd: root,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const logs = out + err
  expect(code, logs).toBe(0)
  expect(err).toContain("CALLER_FAILURE_LOG_CONTROL")
  expect(out).toContain('"caller":"Agent.generate"')
  expect(out).toContain('"caller":"roll-call"')
  expect(out).toContain('"access": false')
  expect(out).toContain('"result":"account-unavailable"')
  expect(out.split("ROLL_CALL_STDOUT")).toHaveLength(7)

  const rows = out
    .split("\n")
    .filter((line) => line.startsWith("CALLER_FAILURE_RESULT "))
    .map(
      (line) =>
        JSON.parse(line.slice("CALLER_FAILURE_RESULT ".length)) as {
          caller: string
          origin: string
          requests: number
          result: string
        },
    )
  expect(rows).toHaveLength(12)
  expect(rows.filter((row) => row.caller === "Agent.generate")).toHaveLength(6)
  expect(rows.filter((row) => row.caller === "roll-call")).toHaveLength(6)
  expect(new Set(rows.map((row) => row.origin)).size).toBe(6)
  const origins = ["quota-429", "service-503", "malformed-400", "timeout", "dns-nested-cause", "malformed-refresh"]
  expect(new Set(rows.map((row) => row.origin))).toEqual(new Set(origins))
  for (const caller of ["Agent.generate", "roll-call"])
    expect(
      rows
        .filter((row) => row.caller === caller)
        .map((row) => row.origin)
        .sort(),
    ).toEqual([...origins].sort())
  expect(rows.every((row) => row.requests >= 1 && row.requests <= 4)).toBe(true)
  expect(
    rows.filter((row) => row.caller === "Agent.generate").every((row) => row.result === "account-unavailable"),
  ).toBe(true)
  expect(rows.filter((row) => row.caller === "roll-call").every((row) => row.result === "closed")).toBe(true)

  for (const marker of [
    "SECRET_ACCESS_A",
    "SECRET_REFRESH_A",
    "ROTATING_REFRESH_A",
    "SECRET_PROVIDER_ERROR",
    "SECRET_ENV_KEY",
    "SECRET_LEGACY_KEY",
    "SECRET_ACCOUNT_B",
    "SECRET_ACCOUNT_B_REFRESH",
  ])
    expect(logs).not.toContain(marker)

  const summary = out.split("\n").find((line) => line.startsWith("CALLER_FAILURE_MATRIX "))
  expect(summary).toBeDefined()
  const matrix = JSON.parse(summary!.slice("CALLER_FAILURE_MATRIX ".length)) as {
    cases: unknown[]
    apiFailures: number
    apiAttempts: number
    logControls: number
    agentFailureRows: number
    rollCallFailureRows: number
  }
  expect(matrix.cases).toHaveLength(12)
  expect(matrix.apiFailures).toBe(14)
  expect(matrix.apiAttempts).toBe(20)
  expect(matrix.logControls).toBe(1)
  expect(matrix.agentFailureRows).toBe(6)
  expect(matrix.rollCallFailureRows).toBe(6)
}, 90_000)
