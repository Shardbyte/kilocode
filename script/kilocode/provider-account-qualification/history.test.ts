import { describe, expect, test } from "bun:test"
import { checkpoints, main } from "./history"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

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
        details: { availability: "NOT_RUN", expectedBun: "1.3.14" },
      })
      expect(value.items[0].commands).toBeUndefined()
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
})
