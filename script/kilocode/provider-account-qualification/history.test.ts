import { describe, expect, test } from "bun:test"
import { attempt, checkpoints, classify, main } from "./history"
import { aggregate, capture, save, type Item } from "./evidence"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
type Audit = Parameters<typeof classify>[0]

function audit(values: Partial<Audit> = {}): Audit {
  return {
    sha: checkpoints.at(-1)!.sha,
    status: "SOURCE_ONLY",
    reason: "install-command-failed",
    verified: true,
    expectedBun: "1.4.2",
    runtimes: { bun: "1.4.2" },
    commands: [],
    executable: null,
    backend: null,
    ...values,
  }
}

async function show(sha: string, file: string) {
  const proc = Bun.spawn(["git", "show", `${sha}:${file}`], { cwd: root, stdout: "pipe", stderr: "ignore" })
  const text = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return text
}

describe("historical runtime checkpoints", () => {
  test("manifest pins each requested commit to its inspected Bun toolchain", async () => {
    expect(checkpoints.map((item) => item.sha)).toEqual([
      "76bcfd40be616a72f4697b3041565f322245b462",
      "7c264af09b44d6af218119de464effca1428b215",
      "72732985186da5a19c8febcb5bef3543541128b8",
      "b20e2688f036703317cf87af35c6a32a2f3d9cd0",
      "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12",
      "f2ad10f5c6c67052940bf19f14ceacf28add6b9d",
      "58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b",
    ])
    for (const item of checkpoints) {
      const top = JSON.parse(await show(item.sha, "package.json"))
      const pkg = JSON.parse(await show(item.sha, "packages/opencode/package.json"))
      expect(top.packageManager).toBe(`bun@${item.bun}`)
      expect(pkg.name).toBe("@kilocode/cli")
      expect(pkg.scripts.build).toBe("bun run script/build.ts")
      expect(await show(item.sha, "packages/opencode/script/build.ts")).toContain("--skip-install")
      expect(await show(item.sha, "packages/opencode/src/index.ts")).toContain("ServeCommand")
      expect(await show(item.sha, "packages/opencode/src/cli/cmd/serve.ts")).toContain("Server.listen")
    }
  })

  test("inspection rejects unknown revisions before writing an archive", async () => {
    await expect(main(["inspect", "deadbeef", root])).rejects.toThrow("checkpoint-not-allowlisted")
  })

  test("missing historical source records unavailability without executing or passing a build", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-unavailable-"))
    try {
      const out = path.join(temp, "evidence.json")
      const checkpoint = checkpoints.at(0)!
      await main(["run", checkpoint.sha, path.join(temp, "absent"), out])
      const value = JSON.parse(await readFile(out, "utf8"))
      expect(value.items).toHaveLength(1)
      expect(value.items.at(0)).toMatchObject({
        status: "NOT_RUN",
        evidence: "NOT_RUN",
        source: { commit: checkpoint.sha },
        details: { availability: "UNAVAILABLE", expectedBun: "1.3.14" },
      })
      expect(value.items[0].commands).toBeUndefined()
      const result = await capture([
        process.execPath,
        path.join(import.meta.dir, "history.ts"),
        "run",
        checkpoint.sha,
        path.join(temp, "absent"),
        path.join(temp, "cli.json"),
      ])
      expect(result.code).toBe(0)
      expect((await Bun.file(path.join(temp, "cli.json")).json()).items.at(0)).toMatchObject({
        status: "NOT_RUN",
        evidence: "NOT_RUN",
      })
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  test("inspect checks out the actual pinned source with independent Git metadata and safe toolchain outputs", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-test-"))
    const target = path.join(temp, "archive")
    const output = path.join(temp, "output")
    const prior = process.env.GITHUB_OUTPUT
    process.env.GITHUB_OUTPUT = output
    try {
      await main(["inspect", checkpoints.at(-1)!.sha, target])
      const meta = JSON.parse(await readFile(path.join(target, "inspected.json"), "utf8"))
      const lines = await readFile(output, "utf8")
      expect(meta.status).toBe("INSPECTED")
      expect(meta.packageManager).toBe("bun@1.4.2")
      expect(meta.cli.name).toBe("@kilocode/cli")
      expect(meta.sourceFormat).toBe("isolated-git-checkout")
      expect(meta.gitMetadata).toBe(true)
      expect(lines).toContain("bun-version=1.4.2")
      expect(lines).toContain(`history-dir=${target}`)
      expect(lines).not.toMatch(/(?:token|secret|password|stdout|stderr)/i)
    } finally {
      if (prior == null) delete process.env.GITHUB_OUTPUT
      else process.env.GITHUB_OUTPUT = prior
      await rm(temp, { recursive: true, force: true })
    }
  })

  test("verified executable plus healthy backend passes executable availability only", () => {
    const item = classify(
      audit({
        status: "EXECUTABLE",
        reason: "binary-version-and-health-observed",
        executable: { argv: ["kilo", "--version"], exitCode: 0, verified: true, version: "7.8.3" },
        backend: { argv: ["kilo", "serve"], healthy: true },
      }),
    )
    expect(item).toMatchObject({
      status: "PASS",
      evidence: "HISTORICAL_EXECUTABLE",
      details: { availability: "EXECUTABLE" },
    })
    expect(item.reason).toContain("client/backend compatibility not asserted")
  })

  test("completed rebuild without executable compatibility passes rebuild availability", () => {
    for (const backend of [null, { argv: ["kilo", "serve"], healthy: false }]) {
      const item = classify(
        audit({
          status: "REBUILDABLE",
          reason: "backend-health-not-established",
          commands: [{ argv: ["bun", "run", "build"], exitCode: 0 }],
          backend,
        }),
      )
      expect(item).toMatchObject({
        status: "PASS",
        evidence: "HISTORICAL_REBUILT",
        details: { availability: "REBUILDABLE" },
      })
      expect(item.reason).toContain("availability evidence only; compatibility execution not established")
    }
  })

  test("attributable historical install/build failures pass source-only classification without publishing output", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-classification-"))
    try {
      for (const reason of ["install-command-failed", "build-command-failed"]) {
        const log = audit({ reason })
        const code = await attempt(
          [
            process.execPath,
            "-e",
            "console.error('error: unavailable historical dependency SYNTHETIC_TOKEN_VALUE');process.exit(1)",
          ],
          temp,
          log,
        )
        expect(code).toBe(1)
        const item = classify(log)
        expect(item).toMatchObject({
          status: "PASS",
          evidence: "SOURCE_INSPECTION",
          details: { availability: "SOURCE_ONLY", commandResults: [{ exitCode: 1 }] },
        })
        expect(item.reason).toContain("compatibility execution not established")
        const out = path.join(temp, "result.json")
        await save(out, [item])
        expect(await readFile(out, "utf8")).not.toMatch(/stdout|stderr|SYNTHETIC_TOKEN_VALUE/)
      }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  test("silent, infrastructure and launch failures cannot become source-only passes", async () => {
    for (const script of [
      "process.exit(1)",
      "console.error('error: ENOSPC');process.exit(1)",
      "console.error('network failure');process.exit(1)",
    ]) {
      await expect(attempt([process.execPath, "-e", script], root, audit())).rejects.toThrow(
        "historical-command-unclassified",
      )
    }
    await expect(attempt([path.join(os.tmpdir(), crypto.randomUUID(), "missing")], root, audit())).rejects.toThrow()
    expect(classify(audit({ failure: "unexpected-audit-failure" }))).toMatchObject({
      status: "FAIL",
      evidence: "SOURCE_INSPECTION",
      details: { availability: null },
    })
  })

  test("contradictory executable claims and unverified provenance fail", () => {
    for (const log of [
      audit({ status: "EXECUTABLE" }),
      audit({ verified: false }),
      audit({
        status: "EXECUTABLE",
        executable: { argv: ["kilo"], exitCode: 0, verified: true, version: "7.8.3" },
        backend: { argv: ["kilo"], healthy: false },
      }),
    ]) {
      expect(classify(log).status).toBe("FAIL")
    }
  })

  test("real audit CLI records SHA, manifest, runtime and unexpected failures and exits nonzero", async () => {
    for (const fault of ["sha", "manifest", "runtime", "unexpected"]) {
      const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-integrity-"))
      try {
        const checkpoint = fault === "runtime" ? checkpoints.at(0)! : checkpoints.at(-1)!
        const target = path.join(temp, "source")
        await main(["inspect", checkpoint.sha, target])
        if (fault === "sha") {
          const result = await capture(["git", "checkout", "-b", "wrong", "d050aa7662ba530fcf889b9b699036abb97bc86b"], {
            cwd: target,
          })
          expect(result.code).toBe(0)
        }
        if (fault === "manifest") {
          const file = path.join(target, "package.json")
          const pkg = await Bun.file(file).json()
          await Bun.write(file, JSON.stringify({ ...pkg, packageManager: "bun@9.9.9" }))
        }
        if (fault === "unexpected") await Bun.write(path.join(target, "package.json"), "invalid JSON")
        const out = path.join(temp, "evidence.json")
        const result = await capture([
          process.execPath,
          path.join(import.meta.dir, "history.ts"),
          "run",
          checkpoint.sha,
          target,
          out,
        ])
        expect(result.code).toBe(1)
        const value = await Bun.file(out).json()
        expect(value.items.at(0)).toMatchObject({
          status: "FAIL",
          evidence: "SOURCE_INSPECTION",
          reason: fault === "unexpected" ? "unexpected-audit-failure" : "historical-source-toolchain-mismatch",
        })
        expect(value.items.at(0).details.availability).toBeNull()
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
    }
  })

  test("aggregation preserves every evidence class and keeps failed Actions jobs failing", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-aggregate-"))
    try {
      const items: Item[] = [
        classify(
          audit({
            status: "EXECUTABLE",
            executable: { argv: ["kilo"], exitCode: 0, verified: true, version: "7.8.3" },
            backend: { argv: ["kilo"], healthy: true },
          }),
        ),
        classify(audit({ status: "REBUILDABLE" })),
        classify(audit()),
        classify(audit({ status: "UNAVAILABLE", verified: false, reason: "source-unavailable" })),
        ...(["CURRENT_EXECUTABLE", "REAL_HTTP_HISTORICAL_PROTOCOL", "PROTOCOL_FIXTURE"] as const).map((evidence) => ({
          id: `fixture:${evidence}`,
          status: "PASS" as const,
          evidence,
          reason: "Aggregator fixture, not campaign execution",
        })),
      ]
      await save(path.join(temp, "evidence.json"), items)
      const result = await aggregate(temp, {})
      expect(result.map((item) => item.evidence)).toEqual(items.map((item) => item.evidence))
      expect(result.map((item) => item.status)).toEqual(items.map((item) => item.status))
      expect(await aggregate(temp, { historical: "failure" })).toContainEqual(
        expect.objectContaining({ id: "job:historical", status: "FAIL" }),
      )
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
