import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkoutFailure } from "./history"
import { capture, environment, save, type Item } from "./evidence"

export const sourceSha = "31bd901b96f349373a521e3bc2c958adc2f93c9c"
export const targets = [
  "76bcfd40be616a72f4697b3041565f322245b462",
  "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12",
  "58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b",
] as const
export const strategies = ["shared-clone", "isolated-clone", "worktree"] as const

type Probe = {
  sha: string
  strategy: (typeof strategies)[number]
  operation: string
  exitCode: number | null
  cloneExit: number | null
  refExists: boolean
  headVerified: boolean
  detached: boolean
  gitMetadata: boolean
  alternates: boolean
  failure: string | null
}

async function command(argv: string[], cwd: string) {
  const result = await capture(argv, { cwd, timeout: 30_000 })
  return { code: result.code, timeout: result.timeout, stdout: result.stdout, stderr: result.stderr }
}

async function inspect(
  dir: string,
  sha: string,
  strategy: Probe["strategy"],
  op: string,
  code: number | null,
  clone: number | null,
  failure: string | null,
): Promise<Probe> {
  const ref = await command(["git", "cat-file", "-e", `${sha}^{commit}`], dir)
  const head = await command(["git", "rev-parse", "HEAD"], dir)
  const sym = await command(["git", "symbolic-ref", "-q", "HEAD"], dir)
  const git = await command(["git", "rev-parse", "--git-dir"], dir)
  const alt = await command(["git", "rev-parse", "--git-path", "objects/info/alternates"], dir)
  return {
    sha,
    strategy,
    operation: op,
    exitCode: code,
    cloneExit: clone,
    refExists: ref.code === 0 && !ref.timeout,
    headVerified: head.code === 0 && head.stdout.trim() === sha && !head.timeout,
    detached: sym.code === 1 && !sym.timeout,
    gitMetadata: git.code === 0 && existsSync(path.resolve(dir, git.stdout.trim())),
    alternates: alt.code === 0 && existsSync(path.resolve(dir, alt.stdout.trim())),
    failure,
  }
}

function item(probe: Probe, cleanup: boolean): Item {
  const mismatch = probe.strategy === "worktree" ? !probe.detached : probe.detached
  const failed =
    probe.failure != null ||
    probe.exitCode !== 0 ||
    !probe.refExists ||
    !probe.headVerified ||
    mismatch ||
    !probe.gitMetadata
  return {
    id: `history-targeted:${probe.strategy}:${probe.sha}`,
    status: failed || !cleanup ? "FAIL" : "PASS",
    evidence: "SOURCE_INSPECTION",
    reason: !cleanup
      ? "temporary-cleanup-failed"
      : failed
        ? (probe.failure ?? "git-operation-failed")
        : "git-checkout-operation-observed; no historical build or availability conclusion",
    source: { commit: probe.sha },
    details: {
      stage: !cleanup ? "temporary-cleanup-failed" : (probe.failure ?? "completed"),
      operation: probe.operation,
      exitCode: probe.exitCode,
      cloneExit: probe.cloneExit,
      refExists: probe.refExists,
      headVerified: probe.headVerified,
      detached: probe.detached,
      gitMetadata: probe.gitMetadata,
      alternates: probe.alternates,
      availability: null,
    },
  }
}

export async function main(args = process.argv.slice(2)) {
  const [dest] = args
  if (!dest || args.length !== 1) throw new Error("history-targeted-output-required")
  const root = path.resolve(import.meta.dir, "../../..")
  const out = path.resolve(dest)
  if (out === root || out.startsWith(`${root}${path.sep}`)) throw new Error("history-targeted-output-inside-checkout")
  const base = path.resolve(process.env.RUNNER_TEMP ?? os.tmpdir())
  await mkdir(base, { recursive: true })
  const temp = await mkdtemp(path.join(base, "kilo-history-targeted-"))
  await chmod(temp, 0o700).catch(async () => {
    await rm(temp, { recursive: true, force: true })
    throw new Error("temporary-directory-setup-failed")
  })
  const home = path.resolve(environment().HOME)
  const src = path.join(temp, "source")
  const probes: Probe[] = []
  const trees: string[] = []
  let cleanup = true
  let verified = false
  let full = false
  let version = "unavailable"
  try {
    await mkdir(home, { recursive: true })
    await chmod(home, 0o700)
    const git = await command(["git", "--version"], root)
    version =
      git.code === 0 && /^git version \d+\.\d+\.\d+(?:\.windows\.\d+)?$/.test(git.stdout.trim())
        ? git.stdout.trim()
        : "unavailable"
    const clone = await command(["git", "clone", "--no-checkout", root, src], root)
    if (clone.code === 0 && !clone.timeout) {
      await chmod(src, 0o700)
      const checkout = await command(["git", "checkout", "--detach", sourceSha], src)
      const head = await command(["git", "rev-parse", "HEAD"], src)
      const shallow = await command(["git", "rev-parse", "--is-shallow-repository"], src)
      const sym = await command(["git", "symbolic-ref", "-q", "HEAD"], src)
      full = shallow.code === 0 && shallow.stdout.trim() === "false" && !shallow.timeout
      verified =
        checkout.code === 0 &&
        !checkout.timeout &&
        head.code === 0 &&
        !head.timeout &&
        head.stdout.trim() === sourceSha &&
        full &&
        sym.code === 1
    }
    for (const sha of targets) {
      for (const strategy of strategies) {
        if (!verified) {
          probes.push({
            sha,
            strategy,
            operation: "source-checkout",
            exitCode: null,
            cloneExit: null,
            refExists: false,
            headVerified: false,
            detached: false,
            gitMetadata: false,
            alternates: false,
            failure: "source-checkout-unverified",
          })
          continue
        }
        const dest = path.join(temp, `${strategy}-${sha}`)
        if (strategy === "worktree") {
          trees.push(dest)
          const result = await command(["git", "worktree", "add", "--detach", dest, sha], src)
          if (existsSync(dest)) await chmod(dest, 0o700)
          const failed = result.code !== 0 || result.timeout ? checkoutFailure(result.stderr) : null
          probes.push(
            existsSync(dest)
              ? await inspect(
                  dest,
                  sha,
                  strategy,
                  "worktree-add-detach",
                  result.timeout ? null : result.code,
                  null,
                  failed,
                )
              : {
                  sha,
                  strategy,
                  operation: "worktree-add-detach",
                  exitCode: result.timeout ? null : result.code,
                  cloneExit: null,
                  refExists: false,
                  headVerified: false,
                  detached: false,
                  gitMetadata: false,
                  alternates: false,
                  failure: failed,
                },
          )
          continue
        }
        const argv =
          strategy === "shared-clone"
            ? ["git", "clone", "--shared", "--no-checkout", src, dest]
            : ["git", "clone", "--no-checkout", src, dest]
        const cloned = await command(argv, src)
        if (cloned.code !== 0 || cloned.timeout) {
          probes.push({
            sha,
            strategy,
            operation: "clone",
            exitCode: cloned.timeout ? null : cloned.code,
            cloneExit: cloned.timeout ? null : cloned.code,
            refExists: false,
            headVerified: false,
            detached: false,
            gitMetadata: false,
            alternates: false,
            failure: "clone-failed",
          })
          continue
        }
        await chmod(dest, 0o700)
        const checked = await command(["git", "checkout", "-b", "qualification", sha], dest)
        const failed = checked.code !== 0 || checked.timeout ? checkoutFailure(checked.stderr) : null
        probes.push(
          await inspect(
            dest,
            sha,
            strategy,
            "checkout-new-qualification-branch",
            checked.timeout ? null : checked.code,
            cloned.code,
            failed,
          ),
        )
      }
    }
  } catch {
    for (const sha of targets) {
      for (const strategy of strategies) {
        if (probes.some((probe) => probe.sha === sha && probe.strategy === strategy)) continue
        probes.push({
          sha,
          strategy,
          operation: "probe-setup",
          exitCode: null,
          cloneExit: null,
          refExists: false,
          headVerified: false,
          detached: false,
          gitMetadata: false,
          alternates: false,
          failure: "probe-setup-failed",
        })
      }
    }
  } finally {
    for (const tree of trees) {
      const result = await command(["git", "worktree", "remove", "--force", tree], src).catch(() => undefined)
      if (!result || result.code !== 0 || result.timeout) cleanup = false
    }
    if (existsSync(src)) {
      const prune = await command(["git", "worktree", "prune"], src).catch(() => undefined)
      if (!prune || prune.code !== 0 || prune.timeout) cleanup = false
    }
    await rm(temp, { recursive: true, force: true }).catch(() => {
      cleanup = false
    })
    try {
      await mkdir(path.dirname(out), { recursive: true })
      await save(
        out,
        probes.map((probe) => item(probe, cleanup)),
        { gitVersion: version, sourceSha, sourceDetached: verified, sourceFullHistory: full, targetedOnly: true },
      )
    } finally {
      await chmod(home, 0o700).catch(() => {
        cleanup = false
      })
      await rm(home, { recursive: true, force: true }).catch(() => {
        cleanup = false
      })
    }
  }
  if (
    !cleanup ||
    probes.length !== targets.length * strategies.length ||
    probes.some((probe) => item(probe, cleanup).status !== "PASS")
  )
    process.exitCode = 1
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("history-targeted-probe-failed")
    process.exitCode = 1
  })
}
