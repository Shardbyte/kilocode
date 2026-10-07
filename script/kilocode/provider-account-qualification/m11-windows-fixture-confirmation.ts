import path from "node:path"
import { capture, save, type Item } from "./evidence"
import { counts } from "./run"

const root = path.resolve(import.meta.dir, "../../..")
const source = "b0ff7f9c2713f24585947ef09776576cd23d778a"
const fixtures = [
  { path: "packages/kilo-vscode/tests/unit/git-ops.test.ts", blob: "833347d876013b7aa2e0ba0970fcc04a77185a55" },
  {
    path: "packages/kilo-vscode/tests/unit/worktree-manager.test.ts",
    blob: "56facb5fed1a0b66992ec131e7a2d215deef2c79",
  },
] as const
const runs = [
  { id: "git-ops-alone", file: fixtures[0].path, expected: 54 },
  { id: "worktree-manager-alone", file: fixtures[1].path, expected: 132 },
  { id: "both", file: `${fixtures[0].path} ${fixtures[1].path}`, expected: 186 },
] as const

export function summary(text: string, expected: number, targets: readonly { file: string; label: string }[]) {
  const value = counts(text)
  const pass = value?.passed ?? -1
  const fail = value?.failed ?? -1
  const skip = value?.skipped ?? -1
  const assertions = value?.assertions ?? -1
  const lines = text.split(/\r?\n/)
  const blocks = new Map<string, string>()
  for (const [index, line] of lines.entries()) {
    if (!line.endsWith(":")) continue
    const file = line.slice(0, -1).replaceAll("\\", "/")
    if (!file.endsWith(".test.ts")) continue
    const end = lines.findIndex(
      (next, at) => at > index && (/^\s*\d+ pass\s*$/.test(next) || /^[^\s].*\.test\.[cm]?[jt]sx?:\s*$/.test(next)),
    )
    blocks.set(file, lines.slice(index + 1, end < 0 ? undefined : end).join("\n"))
  }
  const found = targets
    .filter((target) => {
      const file = target.file.slice("packages/kilo-vscode/".length)
      const block = blocks.get(file) ?? ""
      return block.split(/\r?\n/).some((line) => line.startsWith(`(pass) ${target.label} [`))
    })
    .map((target) => target.label)
  return {
    passed: pass,
    failed: fail,
    skipped: skip,
    assertions,
    valid: value != null && pass === expected && fail === 0 && skip === 0,
    targets: found,
  }
}

async function git(args: string[]) {
  const result = await capture(["git", ...args], { cwd: root, timeout: 10_000 })
  return result.code === 0 ? result.stdout.trim() : undefined
}

async function main() {
  const out = process.argv[2]
  if (!out || path.resolve(out).startsWith(root + path.sep)) throw new Error("artifact-path-must-be-outside-checkout")
  const head = await git(["rev-parse", "HEAD"])
  const parent = await git(["rev-parse", "HEAD^"])
  const blobs = await Promise.all(fixtures.map((item) => git(["rev-parse", `HEAD:${item.path}`])))
  const metadata = {
    canonical_parent_source_sha: source,
    checked_out_diagnostic_sha: head ?? "unavailable",
    scope: "pending-canonical-test-fixture-confirmation",
    expected_test_blobs: fixtures.map((item) => ({ path: item.path, git_blob_sha1: item.blob })),
  }
  const items: Item[] = []
  await save(out, items, metadata)
  if (
    head !== process.env.GITHUB_SHA ||
    parent !== source ||
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.env.QUALIFICATION_RUNNER_OS !== "Windows" ||
    process.env.QUALIFICATION_RUNNER_ARCH !== "X64" ||
    Bun.version !== "1.4.2" ||
    blobs.some((blob, i) => blob !== fixtures[i]?.blob)
  ) {
    items.push({
      id: "identity",
      status: "FAIL",
      evidence: "SOURCE_INSPECTION",
      reason: "Identity, fixture manifest, or Windows toolchain mismatch",
    })
    await save(out, items, metadata)
    process.exitCode = 1
    return
  }
  const cfg = await capture(["git", "config", "--get", "core.autocrlf"], { cwd: root, timeout: 10_000 })
  const autocrlf =
    cfg.code === 1
      ? "unset"
      : cfg.code === 0 && ["true", "false", "input"].includes(cfg.stdout.trim())
        ? cfg.stdout.trim()
        : "invalid"
  const drift = await capture(["git", "diff", "--name-only", source, "--", "packages"], {
    cwd: root,
    timeout: 10_000,
  })
  const changed = drift.stdout.split(/\r?\n/).filter(Boolean).sort()
  const allowed = fixtures.map((item) => item.path).sort()
  const other = await capture(
    [
      "git",
      "diff",
      "--exit-code",
      source,
      "--",
      ".github/actions",
      ".github/workflows/provider-account-qualification.yml",
      "script/kilocode/provider-account-qualification",
      ":(exclude)script/kilocode/provider-account-qualification/m11-windows-fixture-confirmation.ts",
      ":(exclude)script/kilocode/provider-account-qualification/m11-windows-fixture-confirmation.test.ts",
    ],
    { cwd: root, timeout: 10_000 },
  )
  if (
    drift.code !== 0 ||
    JSON.stringify(changed) !== JSON.stringify(allowed) ||
    other.code !== 0 ||
    autocrlf === "invalid"
  ) {
    items.push({
      id: "source-drift",
      status: "FAIL",
      evidence: "SOURCE_INSPECTION",
      reason: "Source drift or autocrlf validation failed",
    })
    await save(out, items, { ...metadata, autocrlf })
    process.exitCode = 1
    return
  }
  const named = [
    { label: "GitOps > applyPatch > applies changes to the working tree", file: fixtures[0].path },
    {
      label: "WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout",
      file: fixtures[1].path,
    },
  ]
  for (const run of runs) {
    const selected = run.file.split(" ").map((file) => file.slice("packages/kilo-vscode/".length))
    const args = [process.execPath, "test", ...selected, "--timeout", "60000"]
    const result = await capture(args, {
      cwd: path.join(root, "packages/kilo-vscode"),
      timeout: 300_000,
      env: {
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_TEST_PROFILE: "",
        TURBO_FORCE: "true",
        GRADLE_OPTS: "-Dorg.gradle.daemon=false",
      },
    }).catch(() => undefined)
    const chosen = named.filter((item) => selected.includes(item.file.slice("packages/kilo-vscode/".length)))
    const recap = summary(result ? `${result.stdout}\n${result.stderr}` : "", run.expected, chosen)
    const ok =
      !!result &&
      result.code === 0 &&
      !result.timeout &&
      recap.valid &&
      chosen.every((item) => recap.targets.includes(item.label))
    items.push({
      id: run.id,
      status: ok ? "PASS" : "FAIL",
      evidence: "CURRENT_EXECUTABLE",
      reason: ok
        ? "Exact scoped unit fixture run passed with required denominator and named target"
        : !result
          ? "setup-failure"
          : result.timeout
            ? "timeout"
            : recap.passed + recap.failed + recap.skipped !== run.expected
              ? "denominator-mismatch"
              : result.code !== 0
                ? "test-failure"
                : "safe-target-or-recap-mismatch",
      commands: [args.map((arg) => (arg === process.execPath ? "bun" : arg))],
      exit: result?.code,
      duration: result?.duration,
      details: { ...recap, timeout: result?.timeout ?? false },
    })
    await save(out, items, { ...metadata, autocrlf })
  }
  if (items.some((item) => item.status !== "PASS")) process.exitCode = 1
}

if (import.meta.main)
  await main().catch(() => {
    console.error("fixture-confirmation-failed")
    process.exitCode = 1
  })
