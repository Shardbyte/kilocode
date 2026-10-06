import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

export type Evidence =
  | "CURRENT_EXECUTABLE"
  | "HISTORICAL_EXECUTABLE"
  | "HISTORICAL_REBUILT"
  | "REAL_HTTP_HISTORICAL_PROTOCOL"
  | "PROTOCOL_FIXTURE"
  | "SOURCE_INSPECTION"
  | "NOT_RUN"

export type Item = {
  id: string
  status: "PASS" | "FAIL" | "NOT_RUN"
  evidence: Evidence
  reason: string
  commands?: string[][]
  exit?: number
  duration?: number
  source?: { commit: string; path?: string; sha256?: string }
  details?: Record<string, unknown>
}

const classes = new Set([
  "CURRENT_EXECUTABLE",
  "HISTORICAL_EXECUTABLE",
  "HISTORICAL_REBUILT",
  "REAL_HTTP_HISTORICAL_PROTOCOL",
  "PROTOCOL_FIXTURE",
  "SOURCE_INSPECTION",
  "NOT_RUN",
])
const forbidden =
  /(?:credentials?|authorization|(?:access|refresh)[_-]?token|api[_-]?key|password|cookie|stdout|stderr)|^(?:access|refresh|tokens?|auth(?:JSON|Content|Store)?|env|environment|logs?|raw)$/i
const markers =
  /(?:SECRET_[A-Z0-9_]+|SYNTHETIC_[A-Z0-9_]+|[A-Z0-9_]*POISON[A-Z0-9_]*|ROTATING_REFRESH_[A-Z0-9_]+|(?:recognizable|synthetic|qualification|dispatch-sentinel)[-a-z0-9_]*(?:access|refresh|token|secret)[-a-z0-9_]*|Bearer\s+[^\s"\\]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-proj-[A-Za-z0-9_-]+)/gi
const home = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `qualification-home-${crypto.randomUUID()}`)
const allowed = new Set([
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "TMP",
  "TEMP",
  "TMPDIR",
  "CI",
  "JAVA_HOME",
  "JAVA_HOME_21_X64",
  "JAVA_HOME_21_ARM64",
  "GRADLE_OPTS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "BUN_INSTALL",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "KILO_BWRAP_PATH",
  "KILO_EXPERIMENTAL_DISABLE_FILEWATCHER",
  "KILO_EXPERIMENTAL_PROVIDER_PROFILES",
  "KILO_TEST_PROFILE",
  "TURBO_FORCE",
])

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    if (/["'](?:access|refresh|(?:access|refresh)[_-]?token|authorization|api[_-]?key)["']\s*:/i.test(value))
      throw new Error("Unsafe serialized credential payload")
    return value.replace(markers, "[REDACTED]").replace(/\b[A-Z0-9_]*(?:ACCESS|REFRESH)[A-Z0-9_]*\b/g, "[REDACTED]")
  }
  if (Array.isArray(value)) return value.map(clean)
  if (value == null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (forbidden.test(key)) throw new Error("Unsafe evidence field")
      if (/^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+)$/.test(key))
        throw new Error("Unsafe environment dump")
      return [clean(key), clean(item)]
    }),
  )
}

export function environment(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const values = Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(([key, value]) => value != null && allowed.has(key)),
  )
  return {
    ...values,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_TEST_HOME: home,
  }
}

export async function capture(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {},
) {
  const start = Date.now()
  await mkdir(home, { recursive: true })
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: environment(opts.env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const state = { timeout: false }
  const timer = setTimeout(() => {
    state.timeout = true
    child.kill("SIGKILL")
  }, opts.timeout ?? 900_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  return { code, stdout, stderr, timeout: state.timeout, duration: Date.now() - start }
}

async function version(argv: string[]) {
  const result = await capture(argv, { timeout: 10_000 }).catch(() => undefined)
  if (!result || result.code !== 0 || result.timeout) return "unavailable"
  return (result.stdout || result.stderr).trim().split("\n").at(0)?.slice(0, 200) ?? "unavailable"
}

export async function metadata() {
  return {
    os: process.platform,
    arch: process.arch,
    runnerOS: process.env.QUALIFICATION_RUNNER_OS ?? "local",
    runnerArch: process.env.QUALIFICATION_RUNNER_ARCH ?? "local",
    runner: process.env.QUALIFICATION_RUNNER ?? process.env.RUNNER_NAME ?? "local",
    image: process.env.ImageOS ?? "unavailable",
    imageVersion: process.env.ImageVersion ?? "unavailable",
    bun: Bun.version,
    node: await version(["node", "--version"]),
    git: await version(["git", "--version"]),
    java: process.env.QUALIFICATION_JAVA === "true" ? await version(["java", "-version"]) : "not applicable",
  }
}

export async function save(out: string, items: Item[], extra: Record<string, unknown> = {}) {
  for (const item of items) {
    if (!classes.has(item.evidence) || !["PASS", "FAIL", "NOT_RUN"].includes(item.status))
      throw new Error("Invalid evidence classification")
    if (item.evidence === "NOT_RUN" && item.status !== "NOT_RUN") throw new Error("Unexecuted evidence cannot pass")
  }
  const revision = await capture(["git", "rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    timeout: 10_000,
  })
  const commit = revision.stdout.trim()
  if (revision.code !== 0 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot bind evidence to checkout")
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
    throw new Error("Checkout differs from expected workflow revision")
  const value = clean({
    ...extra,
    schema: 1,
    commit,
    checked_out_sha: commit,
    workflow_run_id: process.env.GITHUB_RUN_ID ?? "local",
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
    timestamp: new Date().toISOString(),
    platform: await metadata(),
    items,
  })
  await mkdir(path.dirname(out), { recursive: true })
  await Bun.write(out, JSON.stringify(value, null, 2) + "\n")
}

export async function aggregate(dir: string, expected: Record<string, string>) {
  const items: Item[] = []
  const revision = await capture(["git", "rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    timeout: 10_000,
  })
  if (revision.code !== 0) throw new Error("Cannot bind aggregate to checkout")
  const commit = process.env.GITHUB_SHA ?? revision.stdout.trim()
  const visit = async (root: string) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      if (!entry.name.endsWith(".json")) continue
      const value = await Bun.file(file)
        .json()
        .catch(() => undefined)
      if (value?.schema !== 1 || !Array.isArray(value.items) || value.commit !== commit) {
        items.push({
          id: path.relative(dir, file),
          status: "FAIL",
          evidence: "SOURCE_INSPECTION",
          reason: "Malformed or wrong-commit artifact",
        })
        continue
      }
      for (const item of value.items) {
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.reason !== "string" ||
          !classes.has(item.evidence) ||
          !["PASS", "FAIL", "NOT_RUN"].includes(item.status) ||
          (item.evidence === "NOT_RUN" && item.status !== "NOT_RUN")
        ) {
          items.push({
            id: path.relative(dir, file),
            status: "FAIL",
            evidence: "SOURCE_INSPECTION",
            reason: "Invalid artifact evidence classification",
          })
          continue
        }
        const safe = await Promise.resolve()
          .then(() => {
            clean(item)
            clean(value.platform)
            return true
          })
          .catch(() => false)
        if (!safe) {
          items.push({
            id: path.relative(dir, file),
            status: "FAIL",
            evidence: "SOURCE_INSPECTION",
            reason: "Unsafe artifact payload rejected",
          })
          continue
        }
        items.push({ ...item, details: { ...item.details, platform: value.platform } })
      }
    }
  }
  await visit(dir)
  for (const [id, result] of Object.entries(expected)) {
    if (result === "skipped") {
      items.push({ id: `job:${id}`, status: "NOT_RUN", evidence: "NOT_RUN", reason: "Actions job was not executed" })
      continue
    }
    if (result !== "success")
      items.push({
        id: `job:${id}`,
        status: "FAIL",
        evidence: "SOURCE_INSPECTION",
        reason: `Actions job outcome: ${["failure", "cancelled"].includes(result) ? result : "unknown"}`,
      })
    if (!items.some((item) => item.id === id || item.id.startsWith(`${id}:`)))
      items.push({
        id: `missing:${id}`,
        status: "FAIL",
        evidence: "SOURCE_INSPECTION",
        reason: "Required job evidence artifact missing",
      })
  }
  return items
}
