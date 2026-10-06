import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capture } from "./evidence"
import { counts, selected, xml } from "./run"

describe("qualification runner", () => {
  test("selects platform-valid minimal suites without promoting Linux-only groups", () => {
    expect(selected("portable", "linux").map((item) => item.id)).toEqual(["core", "authority", "schemas", "sdk"])
    expect(selected("portable", "windows").map((item) => item.id)).toEqual(["core", "authority", "schemas", "sdk"])
    expect(selected("portable", "macos").map((item) => item.id)).toEqual(["core", "authority", "schemas", "sdk"])
    expect(selected("clients", "windows").map((item) => item.id)).toContain("windows-worktree")
    expect(selected("clients", "macos").map((item) => item.id)).toContain("darwin-profile")
    expect(selected("clients", "linux").map((item) => item.id)).not.toContain("windows-worktree")
    expect(selected("linux-full", "linux").map((item) => item.id)).toContain("qualification")
    expect(() => selected("linux-full", "windows")).toThrow("Linux-only")
    expect(() => selected("linux-full", "macos")).toThrow("Linux-only")
    expect(() => selected("invented", "linux")).toThrow("Unknown qualification tier")
    expect(() => selected("portable", "freebsd")).toThrow("Unknown qualification platform")
    expect(selected("jetbrains", "windows").at(0)?.argv.slice(0, 3)).toEqual(["cmd.exe", "/c", "gradlew.bat"])
    expect(selected("jetbrains", "windows").some((suite) => suite.argv.includes("script/test-ci.ts"))).toBe(false)
  })

  test("parses Bun counts with CRLF and returns undefined for malformed or absent output", () => {
    expect(counts("4 pass\r\n1 fail\r\n2 skip\r\n9 expect() calls\r\n")).toEqual({
      passed: 4,
      failed: 1,
      skipped: 2,
      assertions: 9,
    })
    expect(counts("not a Bun report")).toBeUndefined()
    expect(counts("4 passes\n")).toBeUndefined()
  })

  test("parses JUnit totals and rejects missing or malformed totals", () => {
    expect(xml('<testsuite tests="5" failures="1" errors="1" skipped="1"></testsuite>')).toEqual({
      passed: 2,
      failed: 2,
      skipped: 1,
    })
    expect(xml('<testsuite tests="2" skipped="3"></testsuite>')).toBeUndefined()
    expect(xml('<testsuite failures="1"></testsuite>')).toBeUndefined()
    expect(xml("not XML")).toBeUndefined()
  })

  test("aggregate CLI writes a failing summary even when all evidence artifacts are missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qualification-aggregate-"))
    try {
      const out = path.join(dir, "summary.json")
      const result = await capture([
        process.execPath,
        path.join(import.meta.dir, "run.ts"),
        "aggregate",
        path.join(dir, "missing"),
        out,
      ])
      expect(result.code).toBe(1)
      const value = await Bun.file(out).json()
      expect(value.status).toBe("FAIL")
      expect(value.qualificationAccepted).toBe(false)
      expect(value.commit).toMatch(/^[a-f0-9]{40}$/)
      expect(
        value.items.some(
          (item: { id: string; status: string }) => item.id === "missing:portable:windows" && item.status === "FAIL",
        ),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
