import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"

const finalSHA = "2547dd8f908a8dfcd16d0d3396b46933720f52db"
const history = [
  { name: "M1", sha: "7c264af09b44d6af218119de464effca1428b215", binding: false },
  { name: "M2-M6", sha: "72732985186da5a19c8febcb5bef3543541128b8", binding: true },
  { name: "M7", sha: "b20e2688f036703317cf87af35c6a32a2f3d9cd0", binding: true },
  { name: "M8-M9", sha: "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12", binding: true },
  { name: "M9.5", sha: "f2ad10f5c6c67052940bf19f14ceacf28add6b9d", binding: true },
]

test("historical provider-profile SQLite state round-trips across exact source revisions", async () => {
  await using tmp = await tmpdir()
  const repo = path.resolve(import.meta.dir, "../../../..")
  const core = path.join(repo, "packages/core")
  const worker = path.resolve(import.meta.dir, "../fixture/kilocode-qualification-history-worker.ts")
  const legacy = path.resolve(import.meta.dir, "../fixture/kilocode-qualification-legacy-reader.ts")
  const data = path.join(tmp.path, "worktree")
  await fs.mkdir(data)

  const src = new Map<string, string>()
  for (const item of [{ name: "final", sha: finalSHA }, ...history, { name: "pre-profile", sha: "76bcfd40be616a72f4697b3041565f322245b462" }]) {
    const dir = path.join(tmp.path, item.name)
    await fs.mkdir(dir)
    const git = Bun.spawn(["git", "archive", item.sha, "packages/core"], { cwd: repo, stdout: "pipe", stderr: "ignore" })
    const tar = Bun.spawn(["tar", "-x", "-C", dir], { cwd: repo, stdin: git.stdout, stderr: "ignore" })
    const [gitCode, tarCode] = await Promise.all([git.exited, tar.exited])
    expect(gitCode, `git archive failed for ${item.name}`).toBe(0)
    expect(tarCode, `archive extraction failed for ${item.name}`).toBe(0)
    const root = path.join(dir, "packages/core")
    await fs.symlink(path.join(core, "node_modules"), path.join(root, "node_modules"), "dir")
    src.set(item.name, root)
  }

  const invoke = async (root: string, mode: "produce" | "read", file: string, state: State | undefined) => {
    const child = Bun.spawn(
      [process.execPath, worker, root, mode, file, data, state ? JSON.stringify(state) : "-"],
      { cwd: core, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const code = await child.exited
    expect(code, `${mode} subprocess failed (${code}): ${stderr.replace(/SYNTHETIC_[A-Z_]+/g, "[redacted]")}`).toBe(0)
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_")
    return result
  }

  const rows: Record<string, unknown>[] = []
  for (const item of history) {
    const file = path.join(tmp.path, `${item.name}.db`)
    const written = await invoke(src.get(item.name)!, "produce", file, undefined)
    expect(written).toMatchObject({ revision: 1, defaultMatches: true, credentialMatches: true })
    expect(written.bindingSupported).toBe(item.binding)
    expect(written.bindingMatches).toBe(item.binding)
    const state: State = {
      id: written.id as string,
      revision: 1,
      bindingSupported: item.binding,
      sessionID: written.sessionID as string,
    }
    const read = await invoke(src.get("final")!, "read", file, state)
    expect(read).toMatchObject({
      profileFound: true,
      revision: 1,
      credentialMatches: true,
      defaultMatches: true,
      bindingSupported: true,
      bindingMatches: item.binding,
      credentialRedacted: true,
    })
    rows.push({ direction: `${item.name}->final`, result: read })
  }

  const file = path.join(tmp.path, "final.db")
  const written = await invoke(src.get("final")!, "produce", file, undefined)
  expect(written).toMatchObject({
    revision: 1,
    defaultMatches: true,
    credentialMatches: true,
    bindingSupported: true,
    bindingMatches: true,
  })
  const state: State = {
    id: written.id as string,
    revision: 1,
    bindingSupported: true,
    sessionID: written.sessionID as string,
  }
  for (const item of history) {
    const read = await invoke(src.get(item.name)!, "read", file, state)
    expect(read).toMatchObject({
      profileFound: true,
      revision: 1,
      credentialMatches: true,
      defaultMatches: true,
      bindingSupported: item.binding,
      bindingMatches: item.binding,
      credentialRedacted: true,
    })
    rows.push({ direction: `final->${item.name}`, result: read })
  }

  const auth = path.join(tmp.path, "stale-auth")
  await fs.mkdir(auth)
  await Bun.write(
    path.join(auth, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "SYNTHETIC_STALE_AUTH_REFRESH",
        access: "SYNTHETIC_STALE_AUTH_ACCESS",
        expires: 1_900_000_000_002,
        accountId: "qualification-remote",
      },
    }),
  )
  const downgrade = Bun.spawn([process.execPath, legacy, src.get("pre-profile")!, file, auth], {
    cwd: core,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(downgrade.stdout).text()
  const err = await new Response(downgrade.stderr).text()
  const code = await downgrade.exited
  expect(code, `pre-profile reader failed (${code}): ${err.replace(/SYNTHETIC_[A-Z_]+/g, "[redacted]")}`).toBe(0)
  const stale = JSON.parse(out.trim().split("\n").at(-1)!)
  expect(stale).toEqual({ rowCount: 1, staleAuthObserved: true, method: "chatgpt-browser" })
  expect(out + err).not.toContain("SYNTHETIC_")

  console.log(JSON.stringify({
    ledger: "provider-profile historical SQLite transitions",
    command: "bun test ./test/kilocode/provider-profile-history-qualification.test.ts",
    finalSHA,
    bun: Bun.version,
    archiveDependencySource: path.join(core, "node_modules"),
    tempDir: tmp.path,
    childProcesses: { historicalAndFinalWorkers: 17, archiveAndExtract: 14, total: 31 },
    transitionCount: rows.length,
    transitions: rows,
    preProfileDowngrade: stale,
  }))
})

type State = {
  id: string
  revision: number
  bindingSupported: boolean
  sessionID: string
}
