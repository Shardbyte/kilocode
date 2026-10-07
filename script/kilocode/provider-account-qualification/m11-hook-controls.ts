import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const output = process.argv.at(2)
if (!output) throw new Error("Usage: bun m11-hook-controls.ts <output.json>")

const root = path.resolve(import.meta.dir, "../../..")
const git = Bun.which("git")
const results: Record<string, unknown>[] = []
const temps: string[] = []

const emit = async () => {
  await Bun.write(
    output,
    JSON.stringify(
      {
        diagnosticOnly: true,
        source: "b0ff7f9c2713f24585947ef09776576cd23d778a",
        platform: process.platform,
        bun: Bun.version,
        gitAvailable: Boolean(git),
        expectedCaseCount: 10,
        completedCaseCount: results.length,
        classification:
          process.platform !== "win32"
            ? "WINDOWS_CONTROLS_NOT_EXECUTED"
            : results.length === 10
              ? "WINDOWS_CONTROLS_EXECUTED"
              : "WINDOWS_CONTROLS_PARTIAL",
        results,
      },
      null,
      2,
    ),
  )
}

if (process.platform !== "win32") {
  await emit()
  process.exit(0)
}
if (!git) throw new Error("Git is unavailable; no control was executed")
await import(path.join(root, "packages/kilo-vscode/tests/setup/vscode-mock.ts"))
const { WorktreeManager } = await import(path.join(root, "packages/kilo-vscode/src/agent-manager/WorktreeManager.ts"))

const errorClass = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return {
    hasMessage: Boolean(msg),
    mentionsHook: lower.includes("hook"),
    mentionsPostCheckout: lower.includes("post-checkout") || lower.includes("post_checkout"),
    mentionsHusky: lower.includes("husky"),
    mentionsLefthook: lower.includes("lefthook"),
    mentionsPath: lower.includes("path"),
    mentionsPermission: lower.includes("permission") || lower.includes("access is denied"),
    mentionsShell: lower.includes("shell") || lower.includes("sh.exe"),
    mentionsParallel: lower.includes("parallel") || lower.includes("checkout.workers"),
    mentionsAlreadyCheckedOut: lower.includes("already checked out"),
    mentionsAlreadyExists: lower.includes("already exists"),
  }
}

const run = (args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env) => {
  const child = Bun.spawnSync([git, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    windowsHide: true,
  })
  return {
    code: child.exitCode,
    timeout: child.signalCode !== null,
    stdout: child.stdout.toString("utf8"),
    stderr: child.stderr.toString("utf8"),
  }
}

const setup = async (id: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `m11-${id}-`))
  temps.push(dir)
  const trace = path.join(dir, ".git", "m11-trace2-event.jsonl")
  const home = path.join(dir, "home")
  await fs.mkdir(home)
  const global = path.join(dir, "global.gitconfig")
  await fs.writeFile(global, "")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
  delete env.GIT_CONFIG_COUNT
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete env[key]
  }
  const init = run(["init", "-b", "main", dir], undefined, env)
  if (init.code !== 0) throw new Error(`git init failed: ${JSON.stringify(errorClass(new Error(init.stderr)))}`)
  for (const [key, value] of [
    ["user.email", "m11@example.invalid"],
    ["user.name", "M11 Diagnostic"],
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
    ["core.safecrlf", "false"],
    ["checkout.thresholdForParallelism", "0"],
    ["checkout.workers", id.includes("explicit-one") ? "1" : ""],
  ] as const) {
    if (!value) continue
    const cfg = run(["-C", dir, "config", key, value], undefined, env)
    if (cfg.code !== 0) throw new Error("repo config failed")
  }
  await fs.writeFile(path.join(dir, "README.md"), "m11 fixture\n")
  await Promise.all(
    Array.from({ length: 64 }, (_, index) => fs.writeFile(path.join(dir, `parallel-${index}.txt`), `file ${index}\n`)),
  )
  const add = run(["-C", dir, "add", "."], undefined, env)
  if (add.code !== 0) throw new Error("git add failed")
  const commit = run(["-C", dir, "commit", "-m", "m11 fixture"], undefined, env)
  if (commit.code !== 0) throw new Error("git commit failed")
  const shell = run(["-C", dir, "var", "GIT_SHELL_PATH"], undefined, env)
  const base = shell.stdout.trim().split(/[\\/]/).at(-1)?.toLowerCase() ?? ""
  const gitShell = new Set(["sh", "sh.exe", "bash", "bash.exe"]).has(base) ? base : "unknown"
  await fs.writeFile(trace, "", { mode: 0o600 })
  const config = run(["-C", dir, "config", "--list"], undefined, env)
  const keys = [
    "core.autocrlf",
    "core.eol",
    "core.safecrlf",
    "core.filemode",
    "core.ignorecase",
    "checkout.workers",
    "checkout.thresholdForParallelism",
  ]
  const enums = new Set(["true", "false", "0", "1", "4", "lf", "crlf", "input"])
  const configs = Object.fromEntries(
    keys.map((key) => [
      key,
      config.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${key}=`))
        .map((line) => line.slice(key.length + 1).toLowerCase())
        .filter((value) => enums.has(value)),
    ]),
  )
  return { dir, env, configs, trace, gitShell }
}

const traceStats = async (file: string, enabled: boolean) => {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  const count = (raw ?? "").split(/\r?\n/).reduce((total, line) => {
    try {
      const row: unknown = JSON.parse(line)
      if (
        row &&
        typeof row === "object" &&
        "event" in row &&
        row.event === "child_start" &&
        "argv" in row &&
        Array.isArray(row.argv) &&
        row.argv.some(
          (arg) =>
            typeof arg === "string" &&
            (arg === "checkout--worker" || arg === "--worker" || arg.startsWith("--worker=")),
        )
      )
        return total + 1
    } catch {
      return total
    }
    return total
  }, 0)
  await fs.rm(file, { force: true })
  return {
    workerChildCount: count,
    eligibleParallel:
      raw === undefined
        ? "trace-unavailable"
        : enabled
          ? count > 0
            ? "eligible-workers-observed"
            : "eligible-no-worker-observed"
          : "explicit-one-worker-control",
  }
}

const installHook = async (dir: string, bytes: "LF" | "CRLF") => {
  const hook = path.join(dir, ".git", "hooks", "post-checkout")
  const nl = bytes === "LF" ? "\n" : "\r\n"
  const body = [
    "#!/bin/sh",
    "printf 'called\\n' > .m11-hook-marker",
    "git config --get checkout.workers > .m11-workers",
    "printf 'post-checkout hook failed\\n' >&2",
    "exit 1",
    "",
  ].join(nl)
  await fs.writeFile(hook, body, { encoding: "utf8", mode: 0o755 })
  if (process.platform !== "win32") await fs.chmod(hook, 0o755)
  const stat = await fs.stat(hook)
  return {
    hookBytes: bytes,
    hookBasename: path.basename(hook),
    shebangInterpreter: "sh",
    shebangPresent: body.startsWith("#!/bin/sh" + nl),
    executableModeRequested: true,
    executableBits: (stat.mode & 0o111) !== 0,
    hookPathIsRepoLocal: hook === path.join(dir, ".git", "hooks", "post-checkout"),
  }
}

const registration = async (dir: string, target: string) => {
  const result = run(["-C", dir, "worktree", "list", "--porcelain"])
  const entries = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
  const canon = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase()
  return {
    commandOk: result.code === 0,
    originalIncludesPath: Boolean(target) && result.stdout.includes(target),
    normalizedRegistered: Boolean(target) && entries.some((entry) => canon(entry) === canon(target)),
    listingAvailable: result.code === 0,
    pathCount: entries.length,
  }
}

const marker = async (target: string) =>
  fs.stat(path.join(target, ".m11-hook-marker")).then(
    () => true,
    () => false,
  )
const workers = async (target: string) =>
  fs.readFile(path.join(target, ".m11-workers"), "utf8").then(
    (value) => (["1", "4"].includes(value.trim()) ? value.trim() : null),
    () => null,
  )
const envkeys = [
  "HOME",
  "USERPROFILE",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_COUNT",
  "GIT_TRACE2_EVENT",
  ...Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")),
]

try {
  for (const bytes of ["LF", "CRLF"] as const) {
    for (const mode of ["default", "explicit-one"] as const) {
      const id = `direct-${mode}-${bytes.toLowerCase()}`
      const repo = await setup(id)
      const fixture = await installHook(repo.dir, bytes)
      const target = path.join(repo.dir, ".m11-worktree")
      const cmd = run(
        mode === "default"
          ? [
              "-C",
              repo.dir,
              "-c",
              "checkout.workers=4",
              "worktree",
              "add",
              "-b",
              `m11-${mode}-${bytes.toLowerCase()}`,
              target,
              "main",
            ]
          : ["-C", repo.dir, "worktree", "add", "-b", `m11-${mode}-${bytes.toLowerCase()}`, target, "main"],
        undefined,
        { ...repo.env, GIT_TRACE2_EVENT: repo.trace },
      )
      const trace = await traceStats(repo.trace, mode === "default")
      results.push({
        id,
        control: "direct-git",
        fixture,
        gitShell: repo.gitShell,
        trace,
        configs: repo.configs,
        workerSettingRequested: mode === "default" ? "command-local-4" : "repo-1",
        exitCode: cmd.code,
        timedOut: cmd.timeout,
        error_class: errorClass(new Error(cmd.stderr)),
        worktreeDirectoryExists: await fs.stat(target).then(
          () => true,
          () => false,
        ),
        hookMarkerWritten: await marker(target),
        observedHookWorkerSetting: await workers(target),
        registered: await registration(repo.dir, target),
      })
    }
    for (const mode of ["default", "explicit-one"] as const) {
      const id = `manager-${mode}-${bytes.toLowerCase()}`
      const repo = await setup(id)
      const fixture = await installHook(repo.dir, bytes)
      const logs: string[] = []
      let resolved = false
      let result: { path: string; branch: string } | undefined
      let error: unknown
      const saved = Object.fromEntries(envkeys.map((key) => [key, process.env[key]]))
      for (const key of envkeys) {
        const value = key === "GIT_TRACE2_EVENT" ? repo.trace : repo.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      try {
        const manager = new WorktreeManager(repo.dir, (msg: unknown) => logs.push(String(msg)))
        result = await manager.createWorktree({ branchName: `m11-${mode}-${bytes.toLowerCase()}` })
        resolved = true
      } catch (err) {
        error = err
      } finally {
        for (const key of envkeys) {
          const value = saved[key]
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      const trace = await traceStats(repo.trace, mode === "default")
      const listing = await registration(repo.dir, result?.path ?? "")
      const target = result?.path ?? ""
      const directLog = logs.find((msg) => msg.includes("Ignoring post-checkout hook failure"))
      const config = run(["-C", repo.dir, "config", "--get", "checkout.workers"], undefined, repo.env)
      results.push({
        id,
        control: "actual-worktree-manager",
        fixture,
        gitShell: repo.gitShell,
        trace,
        configs: repo.configs,
        managerResolved: resolved,
        manager_error_class: error === undefined ? { hasMessage: false } : errorClass(error),
        returnedPathPresent: result
          ? await fs.stat(result.path).then(
              () => true,
              () => false,
            )
          : false,
        hookMarkerWritten: result ? await marker(target) : false,
        observedHookWorkerSetting: result ? await workers(target) : null,
        registered: result
          ? listing
          : {
              commandOk: listing.commandOk,
              originalIncludesPath: false,
              normalizedRegistered: false,
              listingAvailable: listing.listingAvailable,
              pathCount: listing.pathCount,
            },
        suppressionLogObserved: Boolean(directLog),
        finalRepoCheckoutWorkers:
          config.code === 0 && ["1", "4"].includes(config.stdout.trim()) ? config.stdout.trim() : null,
      })
    }
  }
  for (const mode of ["direct", "manager"] as const) {
    const id = `original-fixture-${mode}`
    const repo = await setup(id)
    const dir = await fs.realpath(repo.dir)
    const hook = path.join(dir, ".git", "hooks", "post-checkout")
    await fs.writeFile(hook, "#!/bin/sh\nprintf 'post-checkout hook failed' >&2\nexit 1\n", {
      encoding: "utf8",
      mode: 0o755,
    })
    await fs.chmod(hook, 0o755)
    const fixture = {
      exactOriginalBytes: true,
      shebangPresent: true,
      executableModeRequested: true,
      executableBits: ((await fs.stat(hook)).mode & 0o111) !== 0,
      canonicalRoot: dir === (await fs.realpath(dir)),
      noMarker: true,
    }
    if (mode === "direct") {
      const target = path.join(dir, ".m11-original-worktree")
      const cmd = run(
        ["-C", dir, "-c", "checkout.workers=4", "worktree", "add", "-b", "m11-original-fixture", target, "main"],
        undefined,
        { ...repo.env, GIT_TRACE2_EVENT: repo.trace },
      )
      const trace = await traceStats(repo.trace, true)
      const reg = await registration(dir, target)
      results.push({
        id,
        control: "direct-git",
        fixture,
        gitShell: repo.gitShell,
        trace,
        workerSettingRequested: "command-local-4",
        exitCode: cmd.code,
        timedOut: cmd.timeout,
        error_class: errorClass(new Error(cmd.stderr)),
        worktreeDirectoryExists: await fs.stat(target).then(
          () => true,
          () => false,
        ),
        originalPorcelainIncludesPath: reg.originalIncludesPath,
        normalizedRegistered: reg.normalizedRegistered,
        pathCount: reg.pathCount,
      })
      continue
    }
    const logs: string[] = []
    const saved = Object.fromEntries(envkeys.map((key) => [key, process.env[key]]))
    for (const key of envkeys) {
      const value = key === "GIT_TRACE2_EVENT" ? repo.trace : repo.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    let result: { path: string; branch: string } | undefined
    let error: unknown
    try {
      const manager = new WorktreeManager(dir, (msg: unknown) => logs.push(String(msg)))
      result = await manager.createWorktree({ branchName: "m11-original-fixture" })
    } catch (err) {
      error = err
    } finally {
      for (const key of envkeys) {
        const value = saved[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const trace = await traceStats(repo.trace, true)
    const target = result?.path ?? ""
    const reg = await registration(dir, target)
    results.push({
      id,
      control: "actual-worktree-manager",
      fixture,
      gitShell: repo.gitShell,
      trace,
      managerResolved: Boolean(result),
      manager_error_class: error === undefined ? { hasMessage: false } : errorClass(error),
      returnedPathPresent: result
        ? await fs.stat(target).then(
            () => true,
            () => false,
          )
        : false,
      originalPorcelainIncludesPath: reg.originalIncludesPath,
      normalizedRegistered: reg.normalizedRegistered,
      suppressionLogObserved: logs.some((msg) => msg.includes("Ignoring post-checkout hook failure")),
    })
  }
} finally {
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
  await emit()
}
