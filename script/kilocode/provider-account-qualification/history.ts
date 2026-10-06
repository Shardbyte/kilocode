import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { capture, environment, save, type Item } from "./evidence"

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
type Audit = {
  sha: string
  status: Status
  reason: string
  verified: boolean
  failure?: string
  expectedBun: string
  runtimes: Record<string, string | null>
  commands: { argv: string[]; exitCode: number }[]
  executable: { argv: string[]; exitCode: number; verified: boolean; version: string } | null
  backend: { argv: string[]; healthy: boolean } | null
}

export function classify(log: Audit): Item {
  const failed =
    log.failure ??
    (log.status !== "UNAVAILABLE" && !log.verified
      ? "Historical provenance was not verified"
      : log.status === "EXECUTABLE" &&
          (log.executable?.exitCode !== 0 ||
            log.executable?.verified !== true ||
            !log.executable?.version ||
            log.backend?.healthy !== true)
        ? "Executable classification contradicts binary/backend verification"
        : undefined)
  const evidence = failed
    ? "SOURCE_INSPECTION"
    : log.status === "EXECUTABLE"
      ? "HISTORICAL_EXECUTABLE"
      : log.status === "REBUILDABLE"
        ? "HISTORICAL_REBUILT"
        : log.status === "UNAVAILABLE"
          ? "NOT_RUN"
          : "SOURCE_INSPECTION"
  return {
    id: `history:${log.sha}`,
    status: failed ? "FAIL" : log.status === "UNAVAILABLE" ? "NOT_RUN" : "PASS",
    evidence,
    reason:
      failed ??
      (log.status === "UNAVAILABLE"
        ? log.reason
        : `${log.reason}; availability evidence only; ${log.status === "EXECUTABLE" ? "binary/health smoke observed, client/backend compatibility not asserted" : "compatibility execution not established"}`),
    source: { commit: log.sha },
    commands: log.commands.length ? log.commands.map((item) => item.argv) : undefined,
    details: {
      availability: failed ? null : log.status,
      expectedBun: log.expectedBun,
      runtimes: log.runtimes,
      commandResults: log.commands,
      executable: log.executable,
      backend: log.backend,
    },
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..").replaceAll("\\", "/")
const pin = (sha: string) => checkpoints.find((item) => item.sha === sha)
async function cmd(argv: string[], cwd: string, timeout = 600_000) {
  const result = await capture(argv, { cwd, timeout })
  if (result.timeout) throw new Error("historical-command-timeout")
  return result.code
}

async function output(argv: string[], cwd: string) {
  const result = await capture(argv, { cwd, timeout: 10_000 })
  if (result.timeout) throw new Error("historical-command-timeout")
  return { text: (result.stdout || result.stderr).trim(), code: result.code }
}

export async function attempt(argv: string[], cwd: string, log: Audit) {
  const result = await capture(argv, { cwd, timeout: 600_000 })
  log.commands.push({ argv, exitCode: result.code })
  if (result.timeout) throw new Error("historical-command-timeout")
  if (result.code < 0 || result.code >= 128) throw new Error("historical-command-unclassified")
  if (result.code === 0) return 0
  const text = result.stdout + "\n" + result.stderr
  // Attribute legacy command failures without publishing diagnostics or hiding runner failures.
  if (
    /ENOSPC|ENOMEM|EAI_AGAIN|ECONN|ETIMEDOUT|network (?:error|failure)|failed to connect/i.test(text) ||
    !/(?:error|failed|not found|cannot|unsupported|incompatible|no matching|could not)/i.test(text)
  )
    throw new Error("historical-command-unclassified")
  return result.code
}

async function available(sha: string) {
  const result = await capture(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: root, timeout: 10_000 })
  if (result.timeout) throw new Error("historical-command-timeout")
  if (result.code === 0) return true
  if (/corrupt|inflate|permission denied|unable to (?:read|open)|error:/i.test(result.stderr))
    throw new Error("historical-git-probe-failed")
  if (/(?:not a valid object name|could not get object info|bad object|invalid object name)/i.test(result.stderr))
    return false
  throw new Error("historical-git-probe-failed")
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
  if (!(await available(sha))) {
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
  const log: Audit = {
    sha,
    status: "SOURCE_ONLY",
    verified: false,
    reason: "build-failed",
    expectedBun: item.bun,
    runtimes: {},
    commands: [],
    executable: null,
    backend: null,
  }
  await mkdir(path.dirname(out), { recursive: true })
  try {
    await (async () => {
      const exists = await available(sha)
      if (!exists || !existsSync(src)) {
        log.status = "UNAVAILABLE"
        log.reason = exists ? "historical-source-directory-unavailable" : "checkpoint-commit-unavailable"
        return
      }
      if (!existsSync(pkg)) throw new Error("historical-source-corrupted")
      const bun = await output(["bun", "--version"], src)
      log.runtimes.bun = bun.code === 0 ? bun.text : null
      const revision = await output(["git", "rev-parse", "HEAD"], src)
      const manifest = JSON.parse(await readFile(path.join(src, "package.json"), "utf8"))
      if (
        manifest.packageManager !== `bun@${item.bun}` ||
        revision.code !== 0 ||
        revision.text !== sha ||
        bun.code !== 0 ||
        bun.text !== item.bun
      )
        throw new Error("historical-source-toolchain-mismatch")
      if ((await cmd(["git", "diff", "--quiet", "HEAD", "--"], src)) !== 0)
        throw new Error("historical-source-corrupted")
      log.verified = true
      const node = await output(["node", "--version"], src)
      log.runtimes.node = node.code === 0 ? node.text : null
      const install = ["bun", "install", "--frozen-lockfile"]
      const installCode = await attempt(install, src, log)
      if (installCode === 0) {
        const build = ["bun", "run", "--cwd", "packages/opencode", "build", "--", "--single", "--skip-install"]
        const buildCode = await attempt(build, src, log)
        if (buildCode === 0) {
          log.status = "REBUILDABLE"
          const files = Array.from(
            new Bun.Glob(`dist/**/bin/${process.platform === "win32" ? "kilo.exe" : "kilo"}`).scanSync({ cwd: pkg }),
          ).map((file) => path.join(pkg, file))
          const bin = files.find(existsSync)
          if (bin) {
            const argv = [bin, "--version"]
            const observed = await output(argv, src).catch((err: unknown) => {
              if (err instanceof Error && err.message === "historical-command-timeout") return { text: "", code: 124 }
              if (
                err != null &&
                typeof err === "object" &&
                "code" in err &&
                (err.code === "ENOEXEC" || err.code === "EACCES" || (err.code === "ENOENT" && existsSync(bin)))
              )
                return { text: "", code: 126 }
              throw err
            })
            const version = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8")).version
            const verified = observed.text === version || /^0\.0\.0-qualification-\d{12}$/.test(observed.text)
            log.executable = {
              argv: [path.relative(src, bin), "--version"],
              exitCode: observed.code,
              verified,
              version: verified ? observed.text : "unverified",
            }
            if (observed.code === 0 && verified) {
              log.backend = await ready(bin, src)
              log.status = log.backend.healthy ? "EXECUTABLE" : "REBUILDABLE"
              log.reason = log.backend.healthy ? "binary-version-and-health-observed" : "backend-health-not-established"
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
    })()
  } catch (err) {
    const reasons = new Set([
      "historical-command-timeout",
      "historical-command-unclassified",
      "historical-git-probe-failed",
      "historical-source-corrupted",
      "historical-source-toolchain-mismatch",
    ])
    log.failure = err instanceof Error && reasons.has(err.message) ? err.message : "unexpected-audit-failure"
  }
  const result = classify(log)
  await save(out, [result])
  if (result.status === "FAIL") throw new Error("historical-runtime-audit-failed")
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
