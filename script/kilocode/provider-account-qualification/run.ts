import { mkdir } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { stat } from "node:fs/promises"
import path from "node:path"
import { realpath } from "node:fs/promises"
import { aggregate, capture, save, type Item } from "./evidence"
import { clients, jetbrains, linux, portable, type Suite } from "./suites"

export function selected(kind: string, platform: string): Suite[] {
  if (!["linux", "windows", "macos"].includes(platform)) throw new Error("Unknown qualification platform")
  if (kind === "linux-full" && platform !== "linux") throw new Error("Linux-only qualification tier")
  const values =
    kind === "portable"
      ? portable
      : kind === "linux-full"
        ? linux
        : kind === "clients"
          ? clients
          : kind === "jetbrains"
            ? jetbrains(platform)
            : undefined
  if (!values) throw new Error("Unknown qualification tier")
  return values.filter(
    (item) =>
      item.platform === "cross-platform" ||
      item.platform === `${platform}-specific` ||
      (item.platform === "linux-only" && platform === "linux"),
  )
}

export function counts(text: string) {
  const passed = [...text.matchAll(/^\s*(\d+) pass\r?$/gm)].at(-1)?.at(1)
  if (passed == null) return undefined
  return {
    passed: Number(passed),
    failed: Number([...text.matchAll(/^\s*(\d+) fail\r?$/gm)].at(-1)?.at(1) ?? 0),
    skipped: Number([...text.matchAll(/^\s*(\d+) skip\r?$/gm)].at(-1)?.at(1) ?? 0),
    assertions: Number([...text.matchAll(/^\s*(\d+) expect\(\) calls\r?$/gm)].at(-1)?.at(1) ?? 0),
  }
}

export async function diagnostic(text: string, root: string, cwd: string) {
  const lines = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
  const failed: { file: string; name?: string; category: string }[] = []
  const base = await realpath(root)
  let file: string | undefined
  let kind = "unknown-safe"
  for (const line of lines) {
    const head = /^\s*(.+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/.exec(line)
    if (head) {
      const value = head.at(1)!.replaceAll("\\", "/")
      const drive = /^[A-Za-z]:\//.test(value)
      const abs = drive && process.platform !== "win32" ? undefined : path.resolve(cwd, value)
      const real = abs ? await realpath(abs).catch(() => undefined) : undefined
      file =
        real && (real === base || real.startsWith(base + path.sep))
          ? path.relative(base, real).split(path.sep).join("/")
          : undefined
      kind = "unknown-safe"
      continue
    }
    if (/^\s*error:\s*expect\s*\(/i.test(line)) kind = "assertion-failure"
    if (/^\s*error:\s*(?:cannot find module|failed to resolve|unable to resolve|syntaxerror)/i.test(line))
      kind = "test-runner-error"
    if (
      /^\s*error:/.test(line) &&
      !/^\s*error:\s*(?:expect\s*\(|cannot find module|failed to resolve|unable to resolve|syntaxerror)/i.test(line)
    )
      kind = "unknown-safe"
    const fail = /^\s*\(fail\)\s+(.+?)\s+\[\d+(?:\.\d+)?ms\]\s*$/.exec(line)
    if (/^\s*\(pass\)/.test(line)) kind = "unknown-safe"
    if (!fail || !file) continue
    const source = await readFile(path.join(base, file), "utf8").catch(() => undefined)
    if (!source) continue
    const name = fail.at(1)!
    const parts = name.split(" > ")
    const leaf = parts.at(-1)!
    const title = [`test("${leaf}"`, `test('${leaf}'`, `it("${leaf}"`, `it('${leaf}'`]
    const scopes = parts
      .slice(0, -1)
      .every((part) => source.includes(`describe("${part}"`) || source.includes(`describe('${part}'`))
    const unsafe =
      name.length > 240 ||
      /["'][^"'\r\n]+["']\s*:/.test(name) ||
      /(?:secret|token|password|credential|authorization|bearer|synthetic|profile_[ab]|qualification-|invalid_grant|access_denied|server_error|provider[ _-]+(?:diagnostic|error|response|body)|account[ _-]*(?:id[ _-]*)?[:=]?\s*\d+|https?:\/\/|\/[A-Za-z0-9_.-]+(?:\/|$)|~[\\/]|[A-Z]:[\\/]|[\r\n\x00-\x1f\x7f-\x9f]|[^\s]+@[^\s]+|[A-Za-z0-9_-]{40,})/i.test(
        name,
      )
    failed.push({
      file,
      ...(!unsafe && scopes && title.some((value) => source.includes(value)) ? { name } : {}),
      category: kind,
    })
    kind = "unknown-safe"
  }
  return failed
}

export function category(result: { code: number; timeout: boolean } | undefined, text: string) {
  if (!result) return "setup-failure"
  if (result.timeout) return "timeout"
  if (/^\s*error:\s*expect\s*\(/im.test(text)) return "assertion-failure"
  if (/^\s*error:\s*(?:cannot find module|failed to resolve|unable to resolve|syntaxerror)/im.test(text))
    return "test-runner-error"
  if (result.code !== 0) return "process-exit"
  return "unknown-safe"
}

export function xml(text: string) {
  const total = { passed: 0, failed: 0, skipped: 0 }
  const suites = [...text.matchAll(/<testsuite\b([^>]*)>/g)]
  if (!suites.length || !text.includes("</testsuite>")) return undefined
  for (const match of suites) {
    const attrs = Object.fromEntries(
      [...match[1]!.matchAll(/(tests|failures|errors|skipped)=["'](\d+)["']/g)].map((attr) => [
        attr[1],
        Number(attr[2]),
      ]),
    )
    if (attrs.tests == null) return undefined
    const failed = (attrs.failures ?? 0) + (attrs.errors ?? 0)
    const skipped = attrs.skipped ?? 0
    if (failed + skipped > attrs.tests) return undefined
    total.failed += failed
    total.skipped += skipped
    total.passed += attrs.tests - failed - skipped
  }
  return total
}

async function junit(cwd: string, start: number) {
  const total = { passed: 0, failed: 0, skipped: 0 }
  const state = { found: false }
  const combined = path.join(cwd, ".artifacts/unit/junit.xml")
  const files = (await Bun.file(combined).exists())
    ? [combined]
    : await Array.fromAsync(
        new Bun.Glob("{backend,frontend,shared}/build/test-results/test/*.xml").scan({ cwd, absolute: true }),
      )
  for (const file of files) {
    if ((await stat(file)).mtimeMs < start) continue
    const text = await Bun.file(file).text()
    const count = xml(text)
    if (!count) continue
    state.found = true
    total.failed += count.failed
    total.skipped += count.skipped
    total.passed += count.passed
  }
  return state.found ? total : undefined
}

async function main() {
  const [kind, platform, out] = process.argv.slice(2)
  if (!kind || !platform || !out) throw new Error("Expected tier, platform and evidence output")
  if (kind === "aggregate") {
    await mkdir(platform, { recursive: true })
    const needs = JSON.parse(process.env.QUALIFICATION_NEEDS ?? "{}") as Record<string, { result: string }>
    const expected = Object.fromEntries(Object.entries(needs).map(([id, item]) => [id, item.result]))
    for (const os of ["linux", "windows", "macos"]) {
      expected[`portable:${os}`] = "success"
      expected[`clients:${os}`] = "success"
      expected[`jetbrains:${os}`] = "success"
    }
    delete expected["current-platform"]
    delete expected["jetbrains-current"]
    delete expected["historical-audit"]
    const { checkpoints } = await import("./history")
    for (const checkpoint of checkpoints) expected[`history:${checkpoint.sha}`] = "success"
    const items = await aggregate(platform, expected)
    for (const id of ["current-platform", "jetbrains-current", "historical-audit"]) {
      const result = needs[id]?.result
      if (result !== "success")
        items.push({
          id: `job:${id}`,
          status: "FAIL",
          evidence: "SOURCE_INSPECTION",
          reason: `Actions matrix outcome: ${["failure", "cancelled", "skipped"].includes(result ?? "") ? result : "unknown"}`,
        })
    }
    const status = items.some((item) => item.status === "FAIL")
      ? "FAIL"
      : items.some((item) => item.status === "NOT_RUN")
        ? "INCOMPLETE"
        : "PASS"
    await save(out, items, { status, jobs: needs, qualificationAccepted: false })
    console.log(`Evidence collection: ${status}; qualification acceptance is not automatic`)
    if (status === "FAIL") process.exitCode = 1
    return
  }
  const root = path.resolve(import.meta.dir, "../../..")
  const items: Item[] = []
  for (const suite of selected(kind, platform)) {
    const start = Date.now()
    const result = await capture(suite.argv, {
      cwd: path.join(root, suite.cwd),
      timeout: kind === "jetbrains" ? 2_700_000 : 900_000,
      env: {
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_TEST_PROFILE: platform === "macos" ? "darwin" : "",
        TURBO_FORCE: "true",
        GRADLE_OPTS: "-Dorg.gradle.daemon=false",
      },
    }).catch(() => undefined)
    const gradle = suite.id === "jetbrains-full" || suite.id === "jetbrains-boundaries"
    const count = gradle
      ? await junit(path.join(root, suite.cwd), start)
      : result
        ? counts(result.stdout + "\n" + result.stderr)
        : undefined
    const test = gradle || (suite.argv.includes("test") && suite.argv.at(1) !== "run")
    const failed =
      !result ||
      result.code !== 0 ||
      result.timeout ||
      (test && count != null && (count.failed > 0 || count.passed === 0))
    items.push({
      id: `${kind}:${platform}:${suite.id}`,
      status: failed ? "FAIL" : "PASS",
      evidence: "CURRENT_EXECUTABLE",
      reason: !result
        ? "Process could not start"
        : result.timeout
          ? "Command timed out; no retry"
          : failed
            ? "Command failed or executed zero tests"
            : suite.reason,
      commands: [suite.argv.map((arg) => (arg === process.execPath ? "bun" : arg))],
      exit: result?.code,
      duration: result?.duration,
      details: {
        classification: suite.platform,
        ...count,
        ...(failed
          ? {
              diagnostic: {
                category: category(result, result ? result.stdout + "\n" + result.stderr : ""),
                timeout: result?.timeout ?? false,
                failedTests:
                  result && !gradle
                    ? await diagnostic(result.stdout + "\n" + result.stderr, root, path.join(root, suite.cwd))
                    : [],
              },
            }
          : {}),
      },
    })
    await save(out, items)
    console.log(`${suite.id}: ${failed ? "FAIL" : "PASS"}`)
  }
  if (items.some((item) => item.status === "FAIL")) process.exitCode = 1
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("qualification-runner-failed")
    process.exitCode = 1
  })
}
