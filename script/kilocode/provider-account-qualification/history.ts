import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { capture, environment, save } from "./evidence"

export const checkpoints = [
  { sha: "76bcfd40be616a72f4697b3041565f322245b462", bun: "1.3.14" },
  { sha: "7c264af09b44d6af218119de464effca1428b215", bun: "1.3.14" },
  { sha: "72732985186da5a19c8febcb5bef3543541128b8", bun: "1.3.14" },
  { sha: "b20e2688f036703317cf87af35c6a32a2f3d9cd0", bun: "1.3.14" },
  { sha: "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12", bun: "1.3.14" },
  { sha: "f2ad10f5c6c67052940bf19f14ceacf28add6b9d", bun: "1.4.2" },
  { sha: "58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b", bun: "1.4.2" },
] as const

type Status = "EXECUTABLE" | "REBUILDABLE" | "SOURCE_ONLY" | "UNAVAILABLE"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..").replaceAll("\\", "/")
const pin = (sha: string) => checkpoints.find((item) => item.sha === sha)
async function cmd(argv: string[], cwd: string, timeout = 600_000) {
  const result = await capture(argv, { cwd, timeout }).catch(() => undefined)
  if (!result) return 127
  return result.timeout ? 124 : result.code
}

async function output(argv: string[], cwd: string) {
  const result = await capture(argv, { cwd, timeout: 10_000 }).catch(() => undefined)
  if (!result) return { text: "", code: 127 }
  return { text: (result.stdout || result.stderr).trim(), code: result.timeout ? 124 : result.code }
}

async function ready(bin: string, cwd: string) {
  const srv = createServer()
  const listening = Promise.withResolvers<void>()
  srv.once("error", listening.reject)
  srv.listen(0, "127.0.0.1", listening.resolve)
  await listening.promise
  const address = srv.address()
  if (address == null || typeof address === "string") throw new Error("port-allocation-failed")
  const port = address.port
  const closed = Promise.withResolvers<void>()
  srv.close(() => closed.resolve())
  await closed.promise

  const temp = await mkdtemp(path.join(os.tmpdir(), "kilo-history-smoke-"))
  await chmod(temp, 0o700)
  const home = path.join(temp, "home")
  await mkdir(home)
  const argv = [bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)]
  const proc = Bun.spawn(argv, {
    cwd,
    env: {
      ...environment(),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    },
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const start = Date.now()
  let live = false
  while (Date.now() - start < 20_000 && proc.exitCode == null) {
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    const body = await response?.json().catch(() => undefined)
    if (response?.ok && body?.healthy === true) {
      live = true
      break
    }
    await Bun.sleep(250)
  }
  proc.kill("SIGTERM")
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000)
  await proc.exited
  clearTimeout(timer)
  await rm(temp, { recursive: true, force: true })
  return { argv: ["kilo", "serve", "--hostname", "127.0.0.1", "--port", String(port)], healthy: live }
}

function outFile() {
  return process.env.GITHUB_OUTPUT
}

async function inspect(sha: string, dir: string) {
  const item = pin(sha)
  if (!item) throw new Error("checkpoint-not-allowlisted")
  const target = path.resolve(dir)
  if (target === root || target.startsWith(`${root}/`)) throw new Error("archive-target-inside-checkout")
  if (existsSync(target)) throw new Error("archive-target-already-exists")
  await mkdir(path.dirname(target), { recursive: true })
  await mkdir(target, { recursive: true })
  const available = await cmd(["git", "cat-file", "-e", `${sha}^{commit}`], root)
  if (available !== 0) {
    await writeFile(
      path.join(target, "inspected.json"),
      JSON.stringify({ sha, status: "UNAVAILABLE", reason: "commit-unavailable" }, null, 2),
    )
    if (outFile()) {
      const line = `bun-version=${item.bun}\nhistory-dir=${target}\n`
      await writeFile(outFile()!, line, { flag: "a" })
    }
    return
  }
  // Keep independent Git metadata: historical build tools query branch/version information.
  if ((await cmd(["git", "clone", "--shared", "--no-checkout", root, target], root)) !== 0)
    throw new Error("historical-checkout-clone-failed")
  if ((await cmd(["git", "checkout", "-b", "qualification", sha], target)) !== 0)
    throw new Error("historical-checkout-failed")
  const checked = await output(["git", "rev-parse", "HEAD"], target)
  if (checked.code !== 0 || checked.text !== sha) throw new Error("historical-checkout-revision-mismatch")

  const pkg = JSON.parse(await readFile(path.join(target, "packages/opencode/package.json"), "utf8"))
  const top = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"))
  const metadata = {
    sha,
    status: "INSPECTED",
    expectedBun: item.bun,
    sourceFormat: "isolated-git-checkout",
    gitMetadata: true,
    packageManager: top.packageManager ?? null,
    cli: {
      name: pkg.name,
      version: pkg.version,
      build: pkg.scripts?.build ?? null,
      entry: "packages/opencode/src/index.ts",
    },
    buildScript: existsSync(path.join(target, "packages/opencode/script/build.ts")),
    packageLock: existsSync(path.join(target, "bun.lock")) || existsSync(path.join(target, "bun.lockb")),
  }
  if (metadata.packageManager !== `bun@${item.bun}`) throw new Error("checkpoint-toolchain-mismatch")
  await writeFile(path.join(target, "inspected.json"), JSON.stringify(metadata, null, 2))
  if (outFile()) {
    const line = `bun-version=${item.bun}\nhistory-dir=${target}\n`
    await writeFile(outFile()!, line, { flag: "a" })
  }
}

async function run(sha: string, dir: string, dest: string) {
  const item = pin(sha)
  if (!item) throw new Error("checkpoint-not-allowlisted")
  const src = path.resolve(dir)
  if (src === root || src.startsWith(`${root}/`)) throw new Error("source-inside-checkout")
  const out = path.resolve(dest)
  if (out === root || out.startsWith(`${root}/`)) throw new Error("evidence-inside-checkout")
  const pkg = path.join(src, "packages/opencode")
  const log = {
    sha,
    status: "SOURCE_ONLY" as Status,
    reason: "build-failed",
    expectedBun: item.bun,
    runtimes: {} as Record<string, string | null>,
    commands: [] as Array<{ argv: string[]; exitCode: number | null }>,
    executable: null as { argv: string[]; exitCode: number | null } | null,
    backend: null as { argv: string[]; healthy: boolean } | null,
  }
  await mkdir(path.dirname(out), { recursive: true })
  const available = await cmd(["git", "cat-file", "-e", `${sha}^{commit}`], root)
  if (available !== 0 || !existsSync(pkg)) {
    log.status = "UNAVAILABLE"
    log.reason = "source-unavailable"
    await save(out, [
      {
        id: `history:${sha}`,
        status: "NOT_RUN",
        evidence: "NOT_RUN",
        reason: log.reason,
        source: { commit: sha },
        details: { availability: "NOT_RUN", expectedBun: item.bun },
      },
    ])
    return log
  }
  const bun = await output(["bun", "--version"], src)
  log.runtimes.bun = bun.code === 0 ? bun.text : null
  const revision = await output(["git", "rev-parse", "HEAD"], src)
  if (revision.code !== 0 || revision.text !== sha || bun.code !== 0 || bun.text !== item.bun) {
    await save(out, [
      {
        id: `history:${sha}`,
        status: "FAIL",
        evidence: "SOURCE_INSPECTION",
        reason: "Historical checkout or Bun runtime does not match the pinned source/toolchain",
        source: { commit: sha },
        details: { availability: "SOURCE_INSPECTION", expectedBun: item.bun, observedBun: log.runtimes.bun },
      },
    ])
    throw new Error("historical-source-toolchain-mismatch")
  }
  const node = await output(["node", "--version"], src)
  log.runtimes.node = node.code === 0 ? node.text : null
  const install = ["bun", "install", "--frozen-lockfile"]
  const installCode = await cmd(install, src)
  log.commands.push({ argv: install, exitCode: installCode })
  if (installCode === 0) {
    const build = ["bun", "run", "--cwd", "packages/opencode", "build", "--", "--single", "--skip-install"]
    const buildCode = await cmd(build, src)
    log.commands.push({ argv: build, exitCode: buildCode })
    if (buildCode === 0) {
      const files = Array.from(
        new Bun.Glob(`dist/**/bin/${process.platform === "win32" ? "kilo.exe" : "kilo"}`).scanSync({ cwd: pkg }),
      ).map((file) => path.join(pkg, file))
      const bin = files.find(existsSync)
      if (bin) {
        const argv = [bin, "--version"]
        const observed = await output(argv, src)
        log.executable = { argv: [path.relative(src, bin), "--version"], exitCode: observed.code }
        if (observed.code === 0 && observed.text.length > 0) {
          log.status = "EXECUTABLE"
          log.reason = "binary-version-observed"
          log.backend = await ready(bin, src).catch(() => ({ argv: ["kilo", "serve"], healthy: false }))
        } else {
          log.status = "REBUILDABLE"
          log.reason = "binary-version-failed"
        }
      } else {
        log.status = "REBUILDABLE"
        log.reason = "build-completed-no-binary"
      }
    } else {
      log.reason = "build-command-failed"
    }
  } else {
    log.reason = "install-command-failed"
  }
  const failed = log.status !== "EXECUTABLE" || log.backend?.healthy !== true
  const evidence =
    log.status === "EXECUTABLE"
      ? "HISTORICAL_EXECUTABLE"
      : log.status === "REBUILDABLE"
        ? "HISTORICAL_REBUILT"
        : "SOURCE_INSPECTION"
  const result = failed ? "FAIL" : "PASS"
  await save(out, [
    {
      id: `history:${sha}`,
      status: result,
      evidence,
      reason:
        log.status === "EXECUTABLE" && failed
          ? "Historical binary version executed but backend health smoke failed"
          : `${log.reason}; availability only, not client/backend compatibility`,
      source: { commit: sha },
      commands: log.commands.map((item) => item.argv),
      details: {
        availability: evidence,
        expectedBun: item.bun,
        runtimes: log.runtimes,
        commandResults: log.commands,
        executable: log.executable,
        backend: log.backend,
      },
    },
  ])
  if (failed) throw new Error("historical-runtime-audit-failed")
  return log
}

export async function main(args = process.argv.slice(2)) {
  const [action, sha, dir, dest] = args
  if (action === "inspect" && sha && dir) return inspect(sha, dir)
  if (action === "run" && sha && dir && dest) return run(sha, dir, dest)
  throw new Error("usage: history.ts inspect <sha> <dir> | run <sha> <dir> <out>")
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.name : "Error")
    process.exitCode = 1
  })
}
