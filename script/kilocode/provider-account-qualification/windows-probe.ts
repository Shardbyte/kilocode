import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { capture, environment, save, type Item } from "./evidence"
import { counts, diagnostic } from "./run"

const gitFile = "tests/unit/git-ops.test.ts"
const workFile = "tests/unit/worktree-manager.test.ts"
const gitName = "GitOps > applyPatch > applies changes to the working tree"
const workName = "WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout"
const root = path.resolve(import.meta.dir, "../../..")
const cwd = path.join(root, "packages/kilo-vscode")
const allowed = new Set([
  "working-tree-content-assertion",
  "patch-acceptance-assertion",
  "worktree-registration-assertion",
  "fixture-command-failure",
  "unknown-safe",
])

export function commands() {
  return [
    { id: "git-ops-apply-patch", file: gitFile, name: gitName, pattern: `^${gitName}$` },
    { id: "worktree-hook-tolerance", file: workFile, name: workName, pattern: `^${workName}$` },
    { id: "worktree-file-unnamed", file: workFile },
  ]
}

export async function classify(id: string, text: string, failed: number) {
  const spec = {
    "git-ops-apply-patch": {
      file: gitFile,
      rows: {
        512: { code: "expect(result.ok).toBe(true)", kind: "patch-acceptance-assertion" },
        515: { code: 'expect(content).toBe("two\\n")', kind: "working-tree-content-assertion" },
      },
    },
    "worktree-hook-tolerance": {
      file: workFile,
      rows: {
        516: { code: "expect(existsSync(result.path)).toBe(true)", kind: "worktree-registration-assertion" },
        517: {
          code: 'expect((await simpleGit(root).raw(["worktree", "list", "--porcelain"])).includes(result.path)).toBe(true)',
          kind: "worktree-registration-assertion",
        },
      },
    },
    "worktree-file-unnamed": {
      file: workFile,
      rows: {
        34: {
          code: 'throw new Error(`git command failed (${args.join(" ")}): ${err}`)',
          kind: "fixture-command-failure",
        },
      },
    },
  }[id]
  if (!failed) return []
  if (!spec) return Array.from({ length: failed }, () => "unknown-safe")
  const source = await readFile(path.join(cwd, spec.file), "utf8")
  const rows = [...text.matchAll(/(?:^|[\\/])(?:git-ops|worktree-manager)\.test\.ts:(\d+):\d+/gm)].map((match) =>
    Number(match[1]),
  )
  const kinds = [
    ...new Set(
      rows.map((row) => {
        const entry = spec.rows[row as keyof typeof spec.rows]
        if (
          !entry ||
          source
            .split(/\r?\n/)
            .at(row - 1)
            ?.trim() !== entry.code
        )
          return "unknown-safe"
        return entry.kind
      }),
    ),
  ].filter((kind) => allowed.has(kind))
  const values = kinds.slice(0, failed)
  while (values.length < failed) values.push("unknown-safe")
  return values
}

async function run(test: ReturnType<typeof commands>[number], mode: "baseline" | "autocrlf-disabled"): Promise<Item> {
  const argv = [process.execPath, "test", test.file]
  if (test.pattern) argv.push("--test-name-pattern", test.pattern)
  argv.push("--timeout", "60000")
  const result = await capture(argv, {
    cwd,
    timeout: 90_000,
    env: { KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true", KILO_TEST_PROFILE: "", TURBO_FORCE: "true" },
  }).catch(() => undefined)
  const raw = result ? `${result.stdout}\n${result.stderr}` : ""
  const text = raw.slice(-65_536)
  const total = counts(text)
  const failed = total?.failed ?? 0
  const failures = result ? await diagnostic(text, root, cwd) : []
  const item: Item = {
    id: `windows-probe:${mode}:${test.id}`,
    status:
      !result || result.code !== 0 || result.timeout || !total || total.passed === 0 || failed > 0 ? "FAIL" : "PASS",
    evidence: "CURRENT_EXECUTABLE",
    reason: "Windows qualification diagnostic; autocrlf control is not a product configuration fix",
    commands: [
      ["bun", "test", test.file, ...(test.pattern ? ["--test-name-pattern", test.pattern] : []), "--timeout", "60000"],
    ],
    ...(result ? { exit: result.code } : {}),
    details: {
      mode,
      testFile: test.file,
      ...(test.name ? { testName: test.name } : {}),
      ...(total ?? { passed: 0, failed: 0, skipped: 0, assertions: 0 }),
      failureCategories: await classify(test.id, text, failed),
      failedTests: failures,
    },
  }
  return item
}

async function control<T>(home: string, action: () => Promise<T>): Promise<T> {
  const file = path.join(home, ".gitconfig")
  await mkdir(home, { recursive: true })
  const prior = await readFile(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined
    throw err
  })
  const mode = prior ? (await stat(file)).mode & 0o777 : undefined
  const homeMode = (await stat(home)).mode & 0o777
  try {
    await chmod(home, 0o700)
    if (prior) await chmod(file, 0o600)
    await appendFile(
      file,
      `${prior?.length && !prior.toString("utf8").endsWith("\n") ? "\n" : ""}[core]\n\tautocrlf = false\n`,
      { mode: 0o600 },
    )
    return await action()
  } finally {
    if (prior) {
      await writeFile(file, prior)
      await chmod(file, mode ?? 0o600)
    } else await rm(file, { force: true })
    await chmod(home, homeMode)
  }
}

export async function main(out = process.argv.at(2)) {
  if (process.platform !== "win32") throw new Error("windows-probe-requires-windows")
  if (!out) throw new Error("windows-probe-output-required")
  const home = environment().HOME!
  const mode = (await stat(home)).mode & 0o777
  await chmod(home, 0o700)
  try {
    const tests = commands()
    const items: Item[] = []
    for (const test of tests) items.push(await run(test, "baseline"))
    await control(home, async () => {
      for (const test of tests) items.push(await run(test, "autocrlf-disabled"))
    })
    await save(out, items, { targetedOnly: true, probe: "windows-git-fixture-autocrlf" })
    if (items.some((item) => item.status === "FAIL")) process.exitCode = 1
  } finally {
    await chmod(home, mode)
  }
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("windows-probe-failed")
    process.exitCode = 1
  })
}
