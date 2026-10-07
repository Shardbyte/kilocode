import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkoutFailure, checkoutLfsFailure } from "./history"
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
  lfsFilterFailure?: boolean
  initialExit?: number | null
}

type Prep = {
  cloneExit: number | null
  checkoutExit: number | null
  refExists: boolean
  headVerified: boolean
  detached: boolean
  fullHistory: boolean
  gitMetadata: boolean
  alternates: boolean
  repositorySafetyFailure: boolean
  materializationFailure: boolean
  lfsFilterFailure: boolean
  lfsProcessConfigured: boolean
  lfsSmudgeConfigured: boolean
  lfsRequiredConfigured: boolean
  checkoutFailure: string | null
  failure: string | null
  controlAttempted: boolean
  controlExit: number | null
  controlFailure: string | null
  controlHeadVerified: boolean
  controlDetached: boolean
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
    id: probe.operation.startsWith("lfs-control-")
      ? `history-targeted:lfs-control:${probe.strategy}:${probe.sha}`
      : `history-targeted:${probe.strategy}:${probe.sha}`,
    status: failed || !cleanup ? "FAIL" : "PASS",
    evidence: "SOURCE_INSPECTION",
    reason: !cleanup
      ? "temporary-cleanup-failed"
      : failed
        ? (probe.failure ?? "git-operation-failed")
        : probe.operation.startsWith("lfs-control-")
          ? "diagnostic-control-only; original-checkout-failure-preserved; no availability conclusion"
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
      lfsFilterFailure: probe.lfsFilterFailure ?? false,
      initialExit: probe.initialExit ?? null,
      availability: null,
    },
  }
}

export function record(prep: Prep): Item | null {
  if (!prep.failure) return null
  return {
    id: `history-targeted:source-preparation:${sourceSha}`,
    status: "FAIL",
    evidence: "SOURCE_INSPECTION",
    reason: prep.failure,
    source: { commit: sourceSha },
    details: {
      stage: prep.failure,
      operation: "source-clone-and-detached-checkout",
      cloneExit: prep.cloneExit,
      exitCode: prep.checkoutExit,
      refExists: prep.refExists,
      headVerified: prep.headVerified,
      detached: prep.detached,
      fullHistory: prep.fullHistory,
      gitMetadata: prep.gitMetadata,
      alternates: prep.alternates,
      repositorySafetyFailure: prep.repositorySafetyFailure,
      materializationFailure: prep.materializationFailure,
      lfsFilterFailure: prep.lfsFilterFailure,
      lfsProcessConfigured: prep.lfsProcessConfigured,
      lfsSmudgeConfigured: prep.lfsSmudgeConfigured,
      lfsRequiredConfigured: prep.lfsRequiredConfigured,
      controlAttempted: prep.controlAttempted,
      controlExit: prep.controlExit,
      controlFailure: prep.controlFailure,
      controlHeadVerified: prep.controlHeadVerified,
      controlDetached: prep.controlDetached,
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
  const prep: Prep = {
    cloneExit: null as number | null,
    checkoutExit: null as number | null,
    refExists: false,
    headVerified: false,
    detached: false,
    fullHistory: false,
    gitMetadata: false,
    alternates: false,
    repositorySafetyFailure: false,
    materializationFailure: false,
    lfsFilterFailure: false,
    lfsProcessConfigured: false,
    lfsSmudgeConfigured: false,
    lfsRequiredConfigured: false,
    checkoutFailure: null as string | null,
    failure: null as string | null,
    controlAttempted: false,
    controlExit: null as number | null,
    controlFailure: null as string | null,
    controlHeadVerified: false,
    controlDetached: false,
  }
  try {
    await mkdir(home, { recursive: true })
    await chmod(home, 0o700)
    const git = await command(["git", "--version"], root)
    version =
      git.code === 0 && /^git version \d+\.\d+\.\d+(?:\.windows\.\d+)?$/.test(git.stdout.trim())
        ? git.stdout.trim()
        : "unavailable"
    const clone = await command(["git", "clone", "--no-checkout", root, src], root)
    prep.cloneExit = clone.timeout ? null : clone.code
    if (clone.code !== 0 || clone.timeout) prep.failure = "clone-failed"
    if (clone.code === 0 && !clone.timeout) {
      await chmod(src, 0o700)
      const [proc, smudge, req] = await Promise.all([
        command(["git", "config", "--get", "filter.lfs.process"], src),
        command(["git", "config", "--get", "filter.lfs.smudge"], src),
        command(["git", "config", "--get", "filter.lfs.required"], src),
      ])
      prep.lfsProcessConfigured = proc.code === 0 && !proc.timeout
      prep.lfsSmudgeConfigured = smudge.code === 0 && !smudge.timeout
      prep.lfsRequiredConfigured = req.code === 0 && !req.timeout
      const ref = await command(["git", "cat-file", "-e", `${sourceSha}^{commit}`], src)
      const gitDir = await command(["git", "rev-parse", "--git-dir"], src)
      const alt = await command(["git", "rev-parse", "--git-path", "objects/info/alternates"], src)
      prep.refExists = ref.code === 0 && !ref.timeout
      prep.gitMetadata = gitDir.code === 0 && existsSync(path.resolve(src, gitDir.stdout.trim()))
      prep.alternates = alt.code === 0 && existsSync(path.resolve(src, alt.stdout.trim()))
      const checkout = await command(["git", "checkout", "--detach", sourceSha], src)
      prep.checkoutExit = checkout.timeout ? null : checkout.code
      prep.lfsFilterFailure = checkoutLfsFailure(checkout.stderr)
      const stage = checkout.code === 0 ? null : checkoutFailure(checkout.stderr)
      prep.repositorySafetyFailure = stage === "checkout-repository-safety-failed"
      prep.materializationFailure = stage === "checkout-worktree-materialization-failed"
      prep.checkoutFailure = stage
      if (stage) prep.failure = stage
      const head = await command(["git", "rev-parse", "HEAD"], src)
      const shallow = await command(["git", "rev-parse", "--is-shallow-repository"], src)
      const sym = await command(["git", "symbolic-ref", "-q", "HEAD"], src)
      full = shallow.code === 0 && shallow.stdout.trim() === "false" && !shallow.timeout
      prep.fullHistory = full
      prep.headVerified =
        checkout.code === 0 && !checkout.timeout && head.code === 0 && !head.timeout && head.stdout.trim() === sourceSha
      prep.detached = sym.code === 1 && !sym.timeout
      verified = prep.headVerified && prep.detached && full
      if (!verified && !prep.failure) prep.failure = "source-checkout-unverified"
      if (!verified && prep.lfsFilterFailure) {
        prep.controlAttempted = true
        const control = await command(
          [
            "git",
            "-c",
            "filter.lfs.process=",
            "-c",
            "filter.lfs.smudge=",
            "-c",
            "filter.lfs.required=false",
            "checkout",
            "--detach",
            sourceSha,
          ],
          src,
        )
        prep.controlExit = control.timeout ? null : control.code
        prep.controlFailure = control.code === 0 ? null : checkoutFailure(control.stderr)
        const controlHead = await command(["git", "rev-parse", "HEAD"], src)
        const controlSym = await command(["git", "symbolic-ref", "-q", "HEAD"], src)
        prep.controlHeadVerified =
          control.code === 0 &&
          !control.timeout &&
          controlHead.code === 0 &&
          !controlHead.timeout &&
          controlHead.stdout.trim() === sourceSha
        prep.controlDetached = controlSym.code === 1 && !controlSym.timeout
        verified = prep.controlHeadVerified && prep.controlDetached && full
      }
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
        const primary = await inspect(
          dest,
          sha,
          strategy,
          "checkout-new-qualification-branch",
          checked.timeout ? null : checked.code,
          cloned.code,
          failed,
        )
        primary.lfsFilterFailure = checkoutLfsFailure(checked.stderr)
        probes.push(primary)
        if (strategy !== "shared-clone" || !primary.lfsFilterFailure) continue
        const ctrl = path.join(temp, `lfs-control-${sha}`)
        const copy = await command(["git", "clone", "--shared", "--no-checkout", src, ctrl], src)
        if (copy.code !== 0 || copy.timeout) {
          probes.push({
            ...primary,
            operation: "lfs-control-clone",
            exitCode: copy.timeout ? null : copy.code,
            cloneExit: copy.timeout ? null : copy.code,
            failure: "clone-failed",
            initialExit: primary.exitCode,
          })
          continue
        }
        await chmod(ctrl, 0o700)
        const diagnostic = await command(
          [
            "git",
            "-c",
            "filter.lfs.process=",
            "-c",
            "filter.lfs.smudge=",
            "-c",
            "filter.lfs.required=false",
            "checkout",
            "-b",
            "qualification",
            sha,
          ],
          ctrl,
        )
        const failure = diagnostic.code !== 0 || diagnostic.timeout ? checkoutFailure(diagnostic.stderr) : null
        const check = await inspect(
          ctrl,
          sha,
          strategy,
          "lfs-control-checkout-new-qualification-branch",
          diagnostic.timeout ? null : diagnostic.code,
          copy.code,
          failure,
        )
        check.initialExit = primary.exitCode
        probes.push(check)
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
      const source = record(prep)
      const sourceItems = source ? [source] : []
      await save(out, [...sourceItems, ...probes.map((probe) => item(probe, cleanup))], {
        gitVersion: version,
        sourceSha,
        sourceDetached: prep.detached,
        sourceFullHistory: full,
        sourcePreparation: prep,
        sourceControl: prep.lfsFilterFailure
          ? {
              attempted: prep.controlAttempted,
              exitCode: prep.controlExit,
              failure: prep.controlFailure,
              headVerified: prep.controlHeadVerified,
              detached: prep.controlDetached,
            }
          : null,
        targetedOnly: true,
      })
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
    prep.failure != null ||
    probes.filter((probe) => !probe.operation.startsWith("lfs-control-")).length !==
      targets.length * strategies.length ||
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
