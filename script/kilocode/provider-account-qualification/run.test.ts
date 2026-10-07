import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capture } from "./evidence"
import { category, counts, diagnostic, selected, xml } from "./run"
import { save } from "./evidence"

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

  test("parses actual Bun failed-test output and keeps evidence output-free", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qualification-bun-"))
    const cwd = root
    const file = path.join(cwd, "diagnostic.test.ts")
    await Bun.write(
      file,
      `import { test, expect, describe } from "bun:test"\ntest("safe assertion failure", () => expect("SYNTHETIC_ASSERTION_BODY").toBe("PROFILE_A_ACCESS"))\ndescribe("safe suite", () => test("safe child failure", () => expect(1).toBe(2)))\ntest("Bearer SYNTHETIC_POISON", () => expect(1).toBe(2))\n`,
    )
    let text = ""
    let tests: Awaited<ReturnType<typeof diagnostic>> = []
    let error: Awaited<ReturnType<typeof diagnostic>> = []
    try {
      const result = await capture([process.execPath, "test", file], { cwd })
      expect(result.code).toBe(1)
      text = result.stdout + "\n" + result.stderr
      tests = await diagnostic(text, root, cwd)
      expect(await diagnostic(text.replace(/\n/g, "\r\n"), root, cwd)).toEqual(tests)
      const win = text.replaceAll(path.basename(file) + ":", `.\\${path.basename(file)}:`)
      expect(await diagnostic(win.replace(/\n/g, "\r\n"), root, cwd)).toEqual(tests)
      const outside = text.replaceAll(path.basename(file) + ":", `C:\\outside\\${path.basename(file)}:`)
      expect(await diagnostic(outside, root, cwd)).toEqual([])
      const hostile = text.replace(
        "(fail) safe assertion failure",
        "error: TypeError: SYNTHETIC_ERROR_BODY\n    at /home/private/stack.ts:3\nstdout: SYNTHETIC_STDOUT\nstderr: SYNTHETIC_STDERR\n(fail) safe assertion failure",
      )
      error = await diagnostic(hostile, root, cwd)
      expect(error.at(0)?.category).toBe("unknown-safe")
      expect(error.at(0)?.name).toBe("safe assertion failure")
      expect(category({ code: 137, timeout: true }, text)).toBe("timeout")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    expect(text).toMatch(/\.test\.ts:\s*\n/)
    expect(text).toContain("(fail) safe assertion failure")
    expect(text).toContain("error: expect(")
    expect(tests).toEqual([
      {
        file: "diagnostic.test.ts",
        name: "safe assertion failure",
        category: "assertion-failure",
      },
      { file: "diagnostic.test.ts", name: "safe suite > safe child failure", category: "assertion-failure" },
      { file: "diagnostic.test.ts", category: "assertion-failure" },
    ])
    expect(counts(text)?.failed).toBe(3)
    expect(category({ code: 1, timeout: false }, text)).toBe("assertion-failure")
    expect(category({ code: 1, timeout: false }, "error: Cannot find module safe marker")).toBe("test-runner-error")
    expect(category({ code: 1, timeout: false }, "unrecognized failure")).toBe("process-exit")
    expect(category({ code: 1, timeout: true }, "")).toBe("timeout")
    expect(category(undefined, "")).toBe("setup-failure")
    expect(category({ code: 0, timeout: false }, "")).toBe("unknown-safe")

    expect(await diagnostic("format drift\n(no matching test record)", import.meta.dir, import.meta.dir)).toEqual([])
    expect(counts("0 pass\n2 fail\n")).toEqual({ passed: 0, failed: 2, skipped: 0, assertions: 0 })

    const dir = await mkdtemp(path.join(os.tmpdir(), "qualification-diagnostic-"))
    try {
      const out = path.join(dir, "evidence.json")
      await save(out, [
        {
          id: "portable:linux:core",
          status: "FAIL",
          evidence: "CURRENT_EXECUTABLE",
          reason: "Command failed or executed zero tests",
          details: { diagnostic: { category: "assertion-failure", timeout: false, failedTests: [...tests, ...error] } },
        },
      ])
      const artifact = await Bun.file(out).text()
      expect(artifact).toContain("assertion-failure")
      expect(artifact).toContain("diagnostic.test.ts")
      for (const secret of [
        "poison",
        "Bearer",
        "SYNTHETIC",
        "raw-secret",
        "PRIVATE POISON",
        "HOME=",
        "/home/private/stack",
        "TypeError",
        "STDOUT",
        "STDERR",
      ]) {
        expect(artifact).not.toContain(secret)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("omits unsafe static titles and does not carry categories between failed tests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qualification-titles-"))
    const names = [
      "safe first failure",
      "safe second failure",
      "account private@example.com",
      "provider https://private.example/diagnostic",
      "private /Users/example/credentials",
      "private /root/private/account",
      "private ~/.config/account",
      "provider account 123456 invalid_grant",
      "provider response diagnostic details",
      '{"access": "private-provider-value"}',
      "invalid\u007fcontrol",
      "SYNTHETIC_ACCOUNT_SECRET_42",
      "x".repeat(241),
    ]
    try {
      await Bun.write(
        path.join(root, "titles.test.ts"),
        names.map((name) => `test(${JSON.stringify(name)}, () => {})`).join("\n") +
          '\ntest(\'{"access": "private-provider-value"}\', () => {})',
      )
      const text =
        "titles.test.ts:\nerror: expect(value).toBe(expected)\n" +
        names.map((name) => `(fail) ${name} [1.00ms]`).join("\n")
      const failed = await diagnostic(text, root, root)
      expect(failed.at(0)).toMatchObject({ name: names.at(0), category: "assertion-failure" })
      expect(failed.at(1)).toMatchObject({ name: names.at(1), category: "unknown-safe" })
      expect(failed.slice(2).every((item) => item.name == null)).toBe(true)
      const out = path.join(root, "safe.json")
      await save(out, [
        {
          id: "fixture",
          status: "FAIL",
          evidence: "CURRENT_EXECUTABLE",
          reason: "Command failed",
          details: { failedTests: failed },
        },
      ])
      const saved = await Bun.file(out).text()
      for (const name of names.slice(2)) expect(saved).not.toContain(name)
      expect(await diagnostic("missing.test.ts:\n(fail) invented test [1.00ms]", root, root)).toEqual([])
      expect(await diagnostic("titles.test.ts:\n(fail) format drift", root, root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unexpected CLI errors publish only a stable runner failure code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qualification-cli-failure-"))
    try {
      const result = await capture([
        process.execPath,
        path.join(import.meta.dir, "run.ts"),
        "SYNTHETIC_SECRET_TIER",
        "linux",
        path.join(dir, "out.json"),
      ])
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr.trim()).toBe("qualification-runner-failed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("failure recaps cannot duplicate identities or attach failures to the last file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qualification-recap-"))
    try {
      await Bun.write(path.join(root, "first.test.ts"), 'test("safe first failure", () => {})')
      await Bun.write(path.join(root, "last.test.ts"), 'test("safe last pass", () => {})')
      const text = [
        "first.test.ts:",
        "error: expect(value).toBe(expected)",
        "(fail) safe first failure [1.00ms]",
        "last.test.ts:",
        "(pass) safe last pass [1.00ms]",
        "1 test failed:",
        "(fail) safe first failure [1.00ms]",
        "1 pass",
        "1 fail",
      ].join("\n")
      expect(await diagnostic(text, root, root)).toEqual([
        { file: "first.test.ts", name: "safe first failure", category: "assertion-failure" },
      ])
      expect(counts(text)?.failed).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("actual multi-file Bun diagnostics retain each failure once under CI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qualification-ci-recap-"))
    try {
      for (const name of ["first", "last"]) {
        await Bun.write(
          path.join(root, `${name}.test.ts`),
          `import { test, expect } from "bun:test"\ntest("safe ${name} failure", () => expect(1).toBe(2))\n` +
            Array.from({ length: 60 }, (_, index) => `test("safe pass ${index}", () => {})`).join("\n"),
        )
      }
      const result = await capture([process.execPath, "test", root], { cwd: root, env: { CI: "true" } })
      expect(result.code).toBe(1)
      const text = result.stdout + "\n" + result.stderr
      expect(counts(text)?.failed).toBe(2)
      const failed = await diagnostic(text, root, root)
      expect(failed).toHaveLength(2)
      expect(failed.map((item) => item.file).sort()).toEqual(["first.test.ts", "last.test.ts"])
      expect(failed.every((item) => item.category === "assertion-failure")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
