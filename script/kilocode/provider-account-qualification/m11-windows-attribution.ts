import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capture, save } from "./evidence"
import { counts, diagnostic } from "./run"

const source = "b0ff7f9c2713f24585947ef09776576cd23d778a"
const reference = "feb04c94d9555c972ea4c981f9a20e9a9c1f740d"
const root = path.resolve(import.meta.dir, "../../..")
const pkg = "packages/kilo-vscode"
const files = ["tests/unit/git-ops.test.ts", "tests/unit/worktree-manager.test.ts"]
const titles = [
  "GitOps > applyPatch > applies changes to the working tree",
  "WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout",
]

export function locations(text: string, limits: number[]) {
  return files.flatMap((file, index) => {
    const name = path.basename(file).replaceAll(".", "\\.")
    const matches = [...text.matchAll(new RegExp(name + ":(\\d+):(\\d+)", "g"))]
    return [...new Set(matches.map((match) => Number(match.at(1))))]
      .filter((line) => line > 0 && line <= limits.at(index)!)
      .map((line) => ({ file, line }))
  })
}

async function main() {
  const out = process.argv.at(2)
  if (!out) throw new Error("missing-evidence-destination")
  const records: Record<string, unknown>[] = []
  const publish = () =>
    save(out, [], {
      canonical_source_sha: source,
      reference_sha: reference,
      scope: "M11_WINDOWS_ATTRIBUTION_ONLY",
      records,
    })
  await publish()
  const head = await capture(["git", "rev-parse", "HEAD^"], { cwd: root, timeout: 10_000 })
  if (head.code !== 0 || head.stdout.trim() !== source) throw new Error("canonical-parent-mismatch")
  const drift = await capture(
    [
      "git",
      "diff",
      "--name-only",
      source,
      "--",
      "packages",
      ".github/actions",
      ".github/workflows/provider-account-qualification.yml",
    ],
    { cwd: root, timeout: 10_000 },
  )
  if (drift.code !== 0 || drift.stdout.trim()) throw new Error("canonical-source-drift")
  if (
    process.platform !== "win32" ||
    process.env.QUALIFICATION_RUNNER_OS !== "Windows" ||
    process.env.QUALIFICATION_RUNNER_ARCH !== "X64" ||
    Bun.version !== "1.4.2"
  )
    throw new Error("runner-mismatch")
  const git = await capture(["git", "--version"], { cwd: root, timeout: 10_000 })
  records.push({
    id: "toolchain",
    bun: Bun.version,
    git: /^git version [\d.]+(?:\.windows\.\d+)?$/.test(git.stdout.trim()) ? git.stdout.trim() : "unavailable",
  })
  const configs = ["core.autocrlf", "core.eol", "core.safecrlf", "core.filemode", "core.ignorecase"]
  for (const key of configs) {
    const value = await capture(["git", "config", "--get", key], { cwd: root, timeout: 10_000 })
    const enumval = value.stdout.trim()
    records.push({
      id: "inherited-git-config",
      key,
      value:
        value.code === 1
          ? "unset"
          : /^(?:true|false|input|lf|crlf|native|warn)$/.test(enumval)
            ? enumval
            : "unrecognized",
      exit: value.code,
    })
  }
  const limits = await Promise.all(
    files.map(async (file) => (await Bun.file(path.join(root, pkg, file)).text()).split("\n").length),
  )
  const run = async (cwd: string, id: string, selected: string[]) => {
    const argv = [process.execPath, "test", ...selected, "--timeout", "60000"]
    const result = await capture(argv, {
      cwd,
      timeout: 300_000,
      env: {
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_TEST_PROFILE: "",
        TURBO_FORCE: "true",
        GRADLE_OPTS: "-Dorg.gradle.daemon=false",
      },
    })
    const text = result.stdout + "\n" + result.stderr
    const failures = await diagnostic(text, path.resolve(cwd, "../.."), cwd)
    records.push({
      id,
      commands: [["bun", ...argv.slice(1)]],
      exit: result.code,
      timeout: result.timeout,
      counts: counts(text),
      failures,
      assertion_locations: locations(text, limits),
      target_failures: titles.filter((title) => failures.some((item) => item.name === title)),
    })
    await publish()
  }
  const cwd = path.join(root, pkg)
  await run(cwd, "current-git-ops-alone", [files.at(0)!])
  await run(cwd, "current-worktree-alone", [files.at(1)!])
  await run(cwd, "current-both", files)

  const dir = await mkdtemp(path.join(os.tmpdir(), "m11-reference-"))
  const target = path.join(dir, "source")
  try {
    const checkout = await capture(
      [
        "git",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.required=false",
        "worktree",
        "add",
        "--detach",
        target,
        reference,
      ],
      { cwd: root, timeout: 120_000 },
    )
    records.push({
      id: "reference-checkout",
      exit: checkout.code,
      timeout: checkout.timeout,
      lfs_pointer_checkout: true,
    })
    await publish()
    if (checkout.code === 0 && !checkout.timeout) {
      const revision = await capture(["git", "rev-parse", "HEAD"], { cwd: target, timeout: 10_000 })
      const paths = [
        ...files.map((file) => pkg + "/" + file),
        pkg + "/src/agent-manager/GitOps.ts",
        pkg + "/src/agent-manager/WorktreeManager.ts",
      ]
      const equal = await capture(["git", "diff", "--exit-code", source, reference, "--", ...paths], {
        cwd: root,
        timeout: 10_000,
      })
      records.push({
        id: "reference-source-identity",
        requested_sha: reference,
        exact_head: revision.code === 0 && revision.stdout.trim() === reference,
        implicated_tests_and_implementations_identical: equal.code === 0,
      })
      if (revision.code !== 0 || revision.stdout.trim() !== reference || equal.code !== 0)
        throw new Error("reference-identity-mismatch")
      await symlink(path.join(root, "node_modules"), path.join(target, "node_modules"), "junction")
      records.push({
        id: "reference-toolchain",
        dependency_layer: "same-current-installed-dependencies",
        bun: Bun.version,
        independent_reference_install: false,
      })
      await run(path.join(target, pkg), "reference-git-ops-alone", [files.at(0)!])
      await run(path.join(target, pkg), "reference-worktree-alone", [files.at(1)!])
      await run(path.join(target, pkg), "reference-both", files)
    }
  } finally {
    const cleanup = await capture(["git", "worktree", "remove", "--force", target], { cwd: root, timeout: 60_000 })
    records.push({ id: "reference-cleanup", exit: cleanup.code })
    await rm(dir, { recursive: true, force: true })
  }

  for (const name of ["gitops", "hook"]) {
    const file = path.join(path.dirname(out), `m11-windows-attribution-${name}-controls.json`)
    const result = await capture([process.execPath, path.join(import.meta.dir, `m11-${name}-controls.ts`), file], {
      cwd: root,
      timeout: 600_000,
    })
    const exists = await Bun.file(file).exists()
    records.push({
      id: `${name}-controls`,
      exit: result.code,
      timeout: result.timeout,
      structured_evidence_published: exists,
    })
    await publish()
    if (result.code !== 0 || result.timeout || !exists) process.exitCode = 1
  }
  await publish()
}

if (import.meta.main)
  await main().catch(() => {
    console.error("m11-windows-attribution-runner-failed")
    process.exitCode = 1
  })
