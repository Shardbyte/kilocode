import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkoutFailure } from "./history"
import { main, sourceSha, strategies, targets } from "./history-targeted"

async function git(argv: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...argv], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "qualification",
      GIT_AUTHOR_EMAIL: "qualification@example.invalid",
      GIT_COMMITTER_NAME: "qualification",
      GIT_COMMITTER_EMAIL: "qualification@example.invalid",
    },
  })
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stderr }
}

test("historical targeted probe allowlists only the three requested commits and strategies", () => {
  expect(sourceSha).toBe("31bd901b96f349373a521e3bc2c958adc2f93c9c")
  expect(targets).toEqual([
    "76bcfd40be616a72f4697b3041565f322245b462",
    "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12",
    "58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b",
  ])
  expect(strategies).toEqual(["shared-clone", "isolated-clone", "worktree"])
})

test("real Git failures classify to fixed codes without reflecting diagnostics", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-targeted-git-test-"))
  await chmod(temp, 0o700)
  try {
    const repo = path.join(temp, "repo")
    await mkdir(repo)
    expect((await git(["init", "-q"], repo)).code).toBe(0)
    expect((await git(["commit", "--allow-empty", "-m", "fixture"], repo)).code).toBe(0)
    const missing = await git(["checkout", "-b", "qualification", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], repo)
    expect(missing.code).not.toBe(0)
    expect(checkoutFailure(missing.stderr)).toBe("checkout-ref-unresolvable")
    expect(missing.stderr).not.toContain("SYNTHETIC_TOKEN_VALUE")
    expect((await git(["checkout", "-b", "qualification", "HEAD"], repo)).code).toBe(0)
    const existing = await git(["checkout", "-b", "qualification", "HEAD"], repo)
    expect(existing.code).not.toBe(0)
    expect(checkoutFailure(existing.stderr)).toBe("checkout-branch-create-failed")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("hosted checkout probe writes only safe source-inspection operation evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-targeted-result-"))
  await chmod(temp, 0o700)
  const prior = process.env.RUNNER_TEMP
  try {
    process.env.RUNNER_TEMP = temp
    const out = path.join(temp, "history-targeted.json")
    await main([out])
    const text = await Bun.file(out).text()
    const report = JSON.parse(text)
    expect(report.items).toHaveLength(targets.length * strategies.length)
    expect(report.items.map((item: { id: string }) => item.id)).toEqual(
      targets.flatMap((sha) => strategies.map((strategy) => `history-targeted:${strategy}:${sha}`)),
    )
    for (const item of report.items) {
      expect(item).toMatchObject({
        status: "PASS",
        evidence: "SOURCE_INSPECTION",
        source: { commit: expect.any(String) },
        details: {
          refExists: true,
          headVerified: true,
          gitMetadata: true,
          availability: null,
        },
      })
      expect(item.details.operation).toBeTruthy()
      expect(item.details.exitCode).toBe(0)
      expect(item.details.cloneExit).toBe(item.id.includes(":worktree:") ? null : 0)
      expect(typeof item.details.detached).toBe("boolean")
      expect(typeof item.details.alternates).toBe("boolean")
      expect(item).not.toHaveProperty("commands")
    }
    expect(report.sourceSha).toBe(sourceSha)
    expect(report.sourceDetached).toBe(true)
    expect(report.sourceFullHistory).toBe(true)
    expect(report.gitVersion).toMatch(/^git version \d+\.\d+\.\d+/)
    expect(text).not.toMatch(/stdout|stderr|fatal:|SYNTHETIC_TOKEN_VALUE|\/tmp\/|qualification-home-/i)
    expect((await readdir(temp)).sort()).toEqual(["history-targeted.json"])
  } finally {
    if (prior == null) delete process.env.RUNNER_TEMP
    else process.env.RUNNER_TEMP = prior
    await rm(temp, { recursive: true, force: true })
  }
})
