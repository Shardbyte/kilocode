import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type Cmd = {
  argv: string[]
  code: number | null
  timeout: boolean
  errorClass: string | null
}

type Bytes = {
  length: number
  lf: number
  crlf: number
  sha256: string
  expected: "before" | "before-crlf" | "after" | "after-crlf" | "other" | "missing"
  normalizedBefore: boolean
  normalizedAfter: boolean
}

type State = {
  file: Bytes
  status: { dirty: boolean; staged: boolean; untrackedCount: number }
  headTree: string | null
  indexTree: string | null
}

type Stage = {
  status: "PASS" | "FAIL" | "NOT_RUN"
  processExitCode: number | null
  timeout: boolean
  errorClass: string | null
}

type Case = {
  name: string
  config: Record<string, string>
  rounds: number
  isolated: boolean
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const source = path.join(root, "packages/kilo-vscode/src/agent-manager/GitOps.ts")
const file = "a.txt"
const before = Buffer.from("one\n", "ascii")
const after = Buffer.from("two\n", "ascii")
const base = {
  "core.eol": "lf",
  "core.safecrlf": "false",
  "core.filemode": "false",
  "core.ignorecase": "true",
}
const configs: Case[] = [
  { name: "inherited-default", config: {}, rounds: 2, isolated: false },
  { name: "controlled-autocrlf-false", config: { ...base, "core.autocrlf": "false" }, rounds: 2, isolated: true },
  { name: "controlled-autocrlf-true", config: { ...base, "core.autocrlf": "true" }, rounds: 2, isolated: true },
  { name: "controlled-autocrlf-input", config: { ...base, "core.autocrlf": "input" }, rounds: 1, isolated: true },
  {
    name: "controlled-eol-crlf",
    config: { ...base, "core.autocrlf": "false", "core.eol": "crlf" },
    rounds: 1,
    isolated: true,
  },
  {
    name: "controlled-safecrlf-warn",
    config: { ...base, "core.autocrlf": "false", "core.safecrlf": "warn" },
    rounds: 1,
    isolated: true,
  },
  {
    name: "controlled-safecrlf-true",
    config: { ...base, "core.autocrlf": "false", "core.safecrlf": "true" },
    rounds: 1,
    isolated: true,
  },
  {
    name: "controlled-filemode-true",
    config: { ...base, "core.autocrlf": "false", "core.filemode": "true" },
    rounds: 1,
    isolated: true,
  },
  {
    name: "controlled-ignorecase-false",
    config: { ...base, "core.autocrlf": "false", "core.ignorecase": "false" },
    rounds: 1,
    isolated: true,
  },
]

function code(value: number | null): number | null {
  return value == null ? null : value
}

function errorClass(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Error)
    return ["Error", "TypeError", "RangeError", "AbortError"].includes(value.name) ? value.name : "OtherError"
  return "NonError"
}

async function run(argv: string[], cwd: string, env: Record<string, string>, timeout = 60_000): Promise<Cmd> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true })
  let timed = false
  const timer = setTimeout(() => {
    timed = true
    child.kill("SIGKILL")
  }, timeout)
  const [status] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]).finally(() => clearTimeout(timer))
  return { argv: normalizeArgv(argv, root, cwd), code: code(status), timeout: timed, errorClass: null }
}

async function runInput(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  input: string,
  timeout = 60_000,
): Promise<Cmd> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "pipe", windowsHide: true })
  let timed = false
  const timer = setTimeout(() => {
    timed = true
    child.kill("SIGKILL")
  }, timeout)
  const [status] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    (async () => {
      await child.stdin.write(input)
      await child.stdin.end()
    })(),
  ]).finally(() => {
    clearTimeout(timer)
    if (child.exitCode == null) child.kill("SIGKILL")
  })
  return { argv: normalizeArgv(argv, root, cwd), code: code(status), timeout: timed, errorClass: null }
}

export function normalizeArgv(argv: string[], repo: string, worktree: string): string[] {
  return argv.map((value) => {
    const pos = value.indexOf("=")
    const prefix = pos < 0 ? "" : value.slice(0, pos + 1)
    const arg = pos < 0 ? value : value.slice(pos + 1)
    const match = (base: string) =>
      arg === base || arg.startsWith(`${base}${path.sep}`) || arg.startsWith(`${base}/`) || arg.startsWith(`${base}\\`)
    if (match(worktree)) return `${prefix}<WORKTREE>`
    if (match(repo)) return `${prefix}<REPO>`
    if (match(os.tmpdir())) return `${prefix}<TEMP>`
    return value
  })
}

function overlay(env: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const output = Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] != null))
  return { ...output, ...extra, GIT_TERMINAL_PROMPT: "0" }
}

const configEnv = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
]

async function isolated(baseEnv: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "m11-gitops-config-"))
  try {
    const home = path.join(dir, "home")
    const global = path.join(dir, "global.gitconfig")
    const system = path.join(dir, "system.gitconfig")
    await mkdir(path.join(home, "AppData", "Roaming"), { recursive: true })
    await writeFile(global, "")
    await writeFile(system, "")
    const env = Object.fromEntries(
      Object.entries(baseEnv).filter(
        ([key]) => !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM)$/.test(key),
      ),
    )
    return {
      dir,
      env: {
        ...env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_SYSTEM: system,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

async function withProcessEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const keys = new Set([
    ...configEnv,
    ...Object.keys(process.env).filter((key) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)),
    ...Object.keys(env).filter((key) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)),
  ])
  const prior = Object.fromEntries([...keys].map((key) => [key, process.env[key]]))
  for (const key of keys) {
    const value = env[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const key of keys) {
      const value = prior[key]
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function git(cwd: string, args: string[], env: Record<string, string>): Promise<Cmd> {
  return run(["git", ...args], cwd, env)
}

async function config(cwd: string, values: Record<string, string>, env: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    const result = await git(cwd, ["config", "--local", key, value], env)
    if (result.code !== 0) throw new Error("fixture-config-failed")
  }
}

async function result(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  timeout = 60_000,
): Promise<string | null> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  })
  let timed = false
  const timer = setTimeout(() => {
    timed = true
    child.kill("SIGKILL")
  }, timeout)
  const [status, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).arrayBuffer(),
  ]).finally(() => clearTimeout(timer))
  return status === 0 && !timed ? stdout.trim() : null
}

export function inspectBytes(data: Buffer | undefined): Bytes {
  if (!data)
    return {
      length: 0,
      lf: 0,
      crlf: 0,
      sha256: "",
      expected: "missing",
      normalizedBefore: false,
      normalizedAfter: false,
    }
  let lf = 0
  let crlf = 0
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 0x0a) continue
    lf++
    if (index > 0 && data[index - 1] === 0x0d) crlf++
  }
  const normalized = data.toString("ascii").replaceAll("\r\n", "\n")
  return {
    length: data.length,
    lf,
    crlf,
    sha256: createHash("sha256").update(data).digest("hex"),
    expected: data.equals(before)
      ? "before"
      : data.equals(Buffer.from("one\r\n", "ascii"))
        ? "before-crlf"
        : data.equals(after)
          ? "after"
          : data.equals(Buffer.from("two\r\n", "ascii"))
            ? "after-crlf"
            : "other",
    normalizedBefore: normalized === before.toString("ascii"),
    normalizedAfter: normalized === after.toString("ascii"),
  }
}

async function bytes(cwd: string): Promise<Bytes> {
  return inspectBytes(await readFile(path.join(cwd, file)).catch(() => undefined))
}

async function state(cwd: string, env: Record<string, string>): Promise<State> {
  const status = await result(cwd, ["status", "--porcelain=v1", "-z"], env)
  const entries = status?.split("\0").filter(Boolean) ?? []
  return {
    file: await bytes(cwd),
    status: {
      dirty: entries.length > 0,
      staged: entries.some((entry) => entry[0] !== " " && entry[0] !== "?"),
      untrackedCount: entries.filter((entry) => entry.startsWith("??")).length,
    },
    headTree: await result(cwd, ["rev-parse", "HEAD^{tree}"], env),
    indexTree: await result(cwd, ["write-tree"], env),
  }
}

function stage(value: { code?: number | null; ok?: boolean; timeout?: boolean; error?: unknown } | undefined): Stage {
  if (!value) return { status: "NOT_RUN", processExitCode: null, timeout: false, errorClass: null }
  return {
    status: !value.timeout && (value.ok === true || value.code === 0) ? "PASS" : "FAIL",
    processExitCode: value.code ?? null,
    timeout: value.timeout ?? false,
    errorClass: errorClass(value.error),
  }
}

function assertWindows(): void {
  if (process.platform !== "win32") throw new Error("windows-only")
}

async function one(test: Case, round: number, baseEnv: Record<string, string>) {
  const ctl = test.isolated ? await isolated(baseEnv) : undefined
  const cwd = await mkdtemp(path.join(os.tmpdir(), "m11-gitops-control-"))
  const env = ctl?.env ?? { ...baseEnv }
  const meta: Record<string, string | null> = {}
  const commands: Cmd[] = []
  const stages: Record<string, Stage> = {}
  let states: Record<string, State> = {}
  let patch: string | undefined
  let check: { ok: boolean; conflicts: number } | undefined
  let applied: { ok: boolean; conflicts: number } | undefined
  let actualError: unknown
  let directApply: Cmd | undefined
  let checkoutFile: Bytes | undefined
  let gitOps:
    | {
        buildWorktreePatch: (cwd: string, branch: string) => Promise<string>
        checkApplyPatch: (cwd: string, patch: string) => Promise<{ ok: boolean; conflicts: unknown[] }>
        applyPatch: (cwd: string, patch: string) => Promise<{ ok: boolean; conflicts: unknown[] }>
        dispose: () => void
      }
    | undefined
  try {
    const init = await git(cwd, ["init", "-q"], env)
    commands.push(init)
    if (init.code !== 0) {
      stages.init = stage(init)
      return record(test, round, meta, commands, stages, states)
    }
    const local = {
      "user.name": "M11 Qualification",
      "user.email": "m11-qualification@example.invalid",
      ...test.config,
    }
    await config(cwd, local, env)
    const localEnv = env
    for (const key of ["core.autocrlf", "core.eol", "core.safecrlf", "core.filemode", "core.ignorecase"]) {
      const value = await result(cwd, ["config", "--show-origin", "--get", key], localEnv)
      const item = value?.split("\n").at(-1)?.split("\t").at(-1)
      meta[key] = item == null ? null : /^(?:true|false|input|lf|crlf|native|warn)$/.test(item) ? item : "unrecognized"
    }
    await writeFile(path.join(cwd, file), before)
    const add = await git(cwd, ["add", "--", file], localEnv)
    const commit = add.code === 0 ? await git(cwd, ["commit", "-q", "-m", "fixture"], localEnv) : undefined
    commands.push(add)
    if (commit) commands.push(commit)
    stages.commit = stage(commit)
    if (!commit || commit.code !== 0) return record(test, round, meta, commands, stages, states)
    await writeFile(path.join(cwd, file), after)
    const branch = await result(cwd, ["branch", "--show-current"], localEnv)
    if (!branch) throw new Error("fixture-branch-unavailable")
    states.beforeBuild = await state(cwd, localEnv)

    await import(path.join(root, "packages/kilo-vscode/tests/setup/vscode-mock.ts"))
    const loaded = await import(source)
    const GitOps = loaded.GitOps
    gitOps = new GitOps({ log: () => undefined })
    try {
      patch = await withProcessEnv(env, () => gitOps!.buildWorktreePatch(cwd, branch))
      stages.build = stage({ ok: patch.trim().length > 0 })
    } catch (error) {
      stages.build = stage({ ok: false, error })
      actualError = error
    }
    states.afterBuild = await state(cwd, localEnv)
    if (patch?.trim()) {
      const checkout = await git(cwd, ["checkout", "--", file], localEnv)
      commands.push(checkout)
      stages.checkout = stage(checkout)
      if (checkout.code === 0) {
        // Observe bytes only here: do not refresh the index before the original apply path.
        checkoutFile = await bytes(cwd)
        try {
          const appliedResult = await withProcessEnv(env, () => gitOps!.applyPatch(cwd, patch!))
          applied = { ok: appliedResult.ok, conflicts: appliedResult.conflicts.length }
          stages.apply = stage({ ok: appliedResult.ok })
        } catch (error) {
          stages.apply = stage({ ok: false, error })
          actualError = error
        }
        states.afterActualApply = await state(cwd, localEnv)

        const reset = await git(cwd, ["reset", "--hard", "HEAD"], localEnv)
        commands.push(reset)
        stages.reset = stage(reset)
        if (reset.code === 0) {
          const restore = await git(cwd, ["checkout", "--", file], localEnv)
          commands.push(restore)
          stages.restore = stage(restore)
          states.beforeControls = await state(cwd, localEnv)
          if (restore.code === 0) {
            try {
              const checked = await withProcessEnv(env, () => gitOps!.checkApplyPatch(cwd, patch!))
              check = { ok: checked.ok, conflicts: checked.conflicts.length }
              stages.check = stage({ ok: checked.ok })
            } catch (error) {
              stages.check = stage({ ok: false, error })
            }
            states.afterCheck = await state(cwd, localEnv)
            directApply = await runInput(["git", "apply", "--3way", "--whitespace=nowarn", "-"], cwd, localEnv, patch)
            stages.directApply = stage({ code: directApply.code ?? 1, timeout: directApply.timeout })
            states.afterDirectApply = await state(cwd, localEnv)
            const controlReset = await git(cwd, ["reset", "--hard", "HEAD"], localEnv)
            commands.push(controlReset)
            stages.controlReset = stage(controlReset)
            if (controlReset.code === 0) {
              const controlRestore = await git(cwd, ["checkout", "--", file], localEnv)
              commands.push(controlRestore)
              stages.controlRestore = stage(controlRestore)
              states.afterControls = await state(cwd, localEnv)
            }
          } else {
            stages.check = stage(undefined)
            stages.directApply = stage(undefined)
          }
        } else {
          stages.restore = stage(undefined)
          stages.check = stage(undefined)
          stages.directApply = stage(undefined)
        }
      } else {
        stages.check = stage(undefined)
        stages.apply = stage(undefined)
        stages.directApply = stage(undefined)
      }
    }
    return record(test, round, meta, commands, stages, states, {
      gitOpsArgv: {
        check: ["git", "apply", "--3way", "--check", "--whitespace=nowarn", "-"],
        apply: ["git", "apply", "--3way", "--whitespace=nowarn", "-"],
      },
      gitOps: { check, apply: applied },
      checkoutFile,
      directApply: directApply
        ? { argv: directApply.argv, code: directApply.code, timeout: directApply.timeout }
        : null,
      assertion512: applied?.ok === true,
      assertion515: states.afterActualApply?.file.expected === "after",
      assertion515NormalizedAfter: states.afterActualApply?.file.normalizedAfter === true,
      productWouldApply: check?.ok === true && applied?.ok === true,
      applyFalseAfterCheckTrue: check?.ok === true && applied?.ok === false,
      successfulApplyNotExactExpectedBytes: applied?.ok === true && states.afterActualApply?.file.expected !== "after",
      actualErrorClass: errorClass(actualError),
      patch: patch
        ? {
            length: Buffer.byteLength(patch),
            lf: (patch.match(/\n/g) ?? []).length,
            crlf: (patch.match(/\r\n/g) ?? []).length,
            sha256: createHash("sha256").update(patch).digest("hex"),
          }
        : null,
    })
  } finally {
    gitOps?.dispose()
    await rm(cwd, { recursive: true, force: true })
    if (ctl) await rm(ctl.dir, { recursive: true, force: true })
  }
}

function record(
  test: Case,
  round: number,
  config: Record<string, string | null>,
  commands: Cmd[],
  stages: Record<string, Stage>,
  states: Record<string, State>,
  more: Record<string, unknown> = {},
) {
  return {
    case: test.name,
    round,
    configIsolation: test.isolated ? "controlled" : "inherited",
    requestedConfig: test.config,
    effectiveConfig: config,
    commands: commands.map((item) => ({
      argv: item.argv,
      code: item.code,
      timeout: item.timeout,
      errorClass: item.errorClass,
    })),
    stages,
    states,
    ...more,
  }
}

export async function main(argv = process.argv.slice(2)) {
  assertWindows()
  const dest = argv[0]
  if (!dest || path.resolve(dest) === root || path.resolve(dest).startsWith(`${root}${path.sep}`))
    throw new Error("artifact-path-must-be-outside-checkout")
  const out = path.resolve(dest)
  await mkdir(path.dirname(out), { recursive: true })
  const baseEnv = overlay(process.env, { GIT_TERMINAL_PROMPT: "0" })
  const rows: unknown[] = []
  for (const test of configs) {
    for (let round = 1; round <= test.rounds; round++) rows.push(await one(test, round, baseEnv))
  }
  const report = {
    schema: 1,
    platform: process.platform,
    node: process.versions.node,
    gitVersion: await run(["git", "--version"], root, baseEnv).then((item) =>
      item.code === 0 ? "available" : "unavailable",
    ),
    source: "packages/kilo-vscode/src/agent-manager/GitOps.ts",
    fixture: { file, before: "before", after: "after", bytes: [before.length, after.length], encoding: "ASCII" },
    controls: rows,
  }
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}

if (import.meta.main) {
  main().catch(() => {
    console.error("m11-gitops-controls-failed")
    process.exitCode = 1
  })
}
