import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { aggregate, capture, environment, save, type Item } from "./evidence"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualification-evidence-"))
  dirs.push(dir)
  return dir
}

describe("qualification evidence", () => {
  test("captures child success, failure, timeout, and isolated allowlisted environment", async () => {
    const env = environment({ QUALIFICATION_UNSAFE_SENTINEL: "synthetic" })
    expect(env.QUALIFICATION_UNSAFE_SENTINEL).toBeUndefined()
    expect(env.HOME).not.toBe(os.homedir())
    const ok = await capture(
      [process.execPath, "-e", "process.stdout.write(process.env.HOME); process.stderr.write('safe error')"],
      { env: { CI: "yes" } },
    )
    expect(ok).toMatchObject({ code: 0, stderr: "safe error", timeout: false })
    expect(ok.stdout).toBe(env.HOME)
    const filtered = await capture(
      [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({flag:process.env.CI, unsafe:process.env.QUALIFICATION_UNSAFE_SENTINEL, token:process.env.GITHUB_TOKEN}))",
      ],
      { env: { CI: "yes", QUALIFICATION_UNSAFE_SENTINEL: "hidden", GITHUB_TOKEN: "SYNTHETIC_TOKEN_VALUE" } },
    )
    expect(JSON.parse(filtered.stdout)).toEqual({ flag: "yes" })
    const fail = await capture([process.execPath, "-e", "process.exit(7)"])
    expect(fail.code).toBe(7)
    const timeout = await capture([process.execPath, "-e", "setTimeout(() => {}, 10000)"], { timeout: 20 })
    expect(timeout.timeout).toBe(true)
  })

  test("saves actual checkout identity, rejects wrong workflow revision, and redacts output markers", async () => {
    const dir = await temp()
    const out = path.join(dir, "result.json")
    const rev = await capture(["git", "rev-parse", "HEAD"])
    const item: Item = {
      id: "safe",
      status: "PASS",
      evidence: "CURRENT_EXECUTABLE",
      reason: "safe metadata",
      details: { note: "SYNTHETIC_ACCOUNT_SECRET_42" },
    }
    const prior = process.env.GITHUB_SHA
    try {
      delete process.env.GITHUB_SHA
      await save(out, [item], { note: "Bearer SYNTHETIC_TOKEN_VALUE" })
      const saved = JSON.parse(await readFile(out, "utf8"))
      expect(saved.commit).toBe(rev.stdout.trim())
      expect(saved.checked_out_sha).toBe(saved.commit)
      expect(saved.items[0].details.note).toBe("[REDACTED]")
      expect(saved.note).toBe("[REDACTED]")
      expect(saved.items[0].id).toBe("safe")
      process.env.GITHUB_SHA = "0".repeat(40)
      await expect(save(out, [item])).rejects.toThrow("Checkout differs")
    } finally {
      if (prior == null) delete process.env.GITHUB_SHA
      else process.env.GITHUB_SHA = prior
    }
  })

  test("refuses raw output and forbidden serialized fields", async () => {
    const dir = await temp()
    await expect(
      save(path.join(dir, "raw.json"), [
        {
          id: "bad",
          status: "PASS",
          evidence: "CURRENT_EXECUTABLE",
          reason: "unsafe",
          details: { stdout: "raw process output" },
        },
      ]),
    ).rejects.toThrow("Unsafe evidence field")
    await expect(
      save(path.join(dir, "raw.json"), [
        { id: "bad", status: "PASS", evidence: "CURRENT_EXECUTABLE", reason: "unsafe", details: { raw: "output" } },
      ]),
    ).rejects.toThrow("Unsafe evidence field")
    await expect(
      save(path.join(dir, "raw.json"), [
        { id: "bad", status: "PASS", evidence: "REAL_HTTP_HISTORICAL_PROTOCOL", reason: "unexecuted" },
        { id: "unrun", status: "PASS", evidence: "NOT_RUN", reason: "invalid" },
      ]),
    ).rejects.toThrow("Unexecuted evidence cannot pass")
    for (const key of [
      "Authorization",
      "apiKey",
      "access_token",
      "refresh_token",
      "credentialStore",
      "authJSON",
      "environment",
    ]) {
      await expect(save(path.join(dir, "unsafe.json"), [], { details: { [key]: "never-published" } })).rejects.toThrow(
        "Unsafe evidence field",
      )
    }
    await expect(save(path.join(dir, "unsafe.json"), [], environment())).rejects.toThrow("Unsafe environment dump")
    await expect(
      save(path.join(dir, "unsafe.json"), [], { note: '{"access":"private","refresh":"private"}' }),
    ).rejects.toThrow("Unsafe serialized credential payload")
  })

  test("captured hostile output stays internal while safe metadata survives", async () => {
    const dir = await temp()
    const out = path.join(dir, "safe.json")
    const result = await capture([
      process.execPath,
      "-e",
      "process.stdout.write('PROFILE_A_ACCESS');process.stderr.write('qualification-refresh-1');process.exit(3)",
    ])
    await save(out, [
      {
        id: "portable:windows:failure",
        status: "FAIL",
        evidence: "CURRENT_EXECUTABLE",
        reason: "Command failed",
        exit: result.code,
        duration: result.duration,
        details: { count: 2, note: "recognizable-access-fixture PROFILE_A_ACCESS qualification-refresh-1" },
      },
    ])
    const text = await readFile(out, "utf8")
    expect(text).not.toContain(result.stdout)
    expect(text).not.toContain(result.stderr)
    expect(text).not.toMatch(/stdout|stderr|recognizable-access-fixture/)
    expect(JSON.parse(text).items[0]).toMatchObject({ status: "FAIL", exit: 3, details: { count: 2 } })
    await expect(save(out, [], { result })).rejects.toThrow("Unsafe evidence field")
  })

  test("aggregates pass, fail, not-run, missing artifacts, and rejects wrong commits and promoted protocol evidence", async () => {
    const dir = await temp()
    const write = async (name: string, value: unknown) => Bun.write(path.join(dir, name), JSON.stringify(value))
    const commit = "a".repeat(40)
    await write("good.json", {
      schema: 1,
      commit,
      platform: { os: "linux" },
      items: [
        { id: "portable:linux:core", status: "PASS", evidence: "CURRENT_EXECUTABLE", reason: "ran" },
        { id: "portable:linux:skip", status: "NOT_RUN", evidence: "NOT_RUN", reason: "not run" },
        {
          id: "portable:linux:protocol",
          status: "PASS",
          evidence: "REAL_HTTP_HISTORICAL_PROTOCOL",
          reason: "historical protocol only",
        },
      ],
    })
    await write("wrong.json", {
      schema: 1,
      commit: "b".repeat(40),
      items: [{ id: "portable:linux:wrong", status: "PASS", evidence: "CURRENT_EXECUTABLE", reason: "wrong" }],
    })
    await write("unsafe.json", {
      schema: 1,
      commit,
      items: [
        {
          id: "unsafe",
          status: "PASS",
          evidence: "CURRENT_EXECUTABLE",
          reason: "not publishable",
          details: { stdout: "SYNTHETIC_SECRET_VALUE" },
        },
      ],
    })
    await write("windows.json", {
      schema: 1,
      commit,
      platform: { os: "win32", runnerArch: "X64" },
      items: [{ id: "portable:windows:failed", status: "FAIL", evidence: "CURRENT_EXECUTABLE", reason: "test failed" }],
    })
    const prior = process.env.GITHUB_SHA
    process.env.GITHUB_SHA = commit
    try {
      const items = await aggregate(dir, {
        "portable:linux": "success",
        "portable:windows": "skipped",
        "clients:macos": "success",
      })
      expect(items).toContainEqual(
        expect.objectContaining({ id: "portable:linux:core", status: "PASS", details: { platform: { os: "linux" } } }),
      )
      expect(items).toContainEqual(expect.objectContaining({ id: "portable:linux:skip", status: "NOT_RUN" }))
      expect(items).toContainEqual(
        expect.objectContaining({ id: "portable:linux:protocol", evidence: "REAL_HTTP_HISTORICAL_PROTOCOL" }),
      )
      expect(items).toContainEqual(expect.objectContaining({ id: "wrong.json", status: "FAIL" }))
      expect(items).toContainEqual(
        expect.objectContaining({ id: "unsafe.json", status: "FAIL", reason: "Unsafe artifact payload rejected" }),
      )
      expect(JSON.stringify(items)).not.toContain("SYNTHETIC_SECRET_VALUE")
      expect(items).toContainEqual(expect.objectContaining({ id: "missing:clients:macos", status: "FAIL" }))
      expect(items).toContainEqual(expect.objectContaining({ id: "job:portable:windows", status: "NOT_RUN" }))
      expect(items).toContainEqual(
        expect.objectContaining({
          id: "portable:windows:failed",
          status: "FAIL",
          evidence: "CURRENT_EXECUTABLE",
          details: { platform: { os: "win32", runnerArch: "X64" } },
        }),
      )
      expect(items.some((item) => item.evidence === "HISTORICAL_EXECUTABLE")).toBe(false)
      expect(items.some((item) => item.evidence === "REAL_HTTP_HISTORICAL_PROTOCOL" && item.id === "wrong.json")).toBe(
        false,
      )
    } finally {
      if (prior == null) delete process.env.GITHUB_SHA
      else process.env.GITHUB_SHA = prior
    }
  })
})
