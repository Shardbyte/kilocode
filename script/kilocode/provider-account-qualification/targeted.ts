import path from "node:path"
import { capture, save, type Item } from "./evidence"
import { category, counts, diagnostic, junit, selected } from "./run"

const revision = "31bd901b96f349373a521e3bc2c958adc2f93c9c"

export function commands(platform: string) {
  if (platform === "macos") return selected("jetbrains", platform)
  if (platform !== "windows") throw new Error("target-platform-not-allowlisted")
  const files = [
    "src/services/commit-message/__tests__/index.spec.ts",
    "tests/unit/worktree-manager.test.ts",
    "tests/unit/git-ops.test.ts",
  ]
  return [...files.map((file) => [file]), files].map((group, index) => ({
    id: index === files.length ? "combined" : path.basename(group.at(0)!),
    cwd: "packages/kilo-vscode",
    argv: [process.execPath, "test", ...group, "--timeout", "60000"],
  }))
}

export function stage(text: string, code: number) {
  if (code === 0) return "completed"
  if (/dubious ownership|unsafe repository|safe\.directory/i.test(text)) return "repository-safety"
  if (/not a git repository|could not find.*git|git metadata|cannot find.*git directory/i.test(text))
    return "git-metadata"
  if (
    /could not resolve|could not download|failed to download|connection (?:reset|timed out)|PKIX|SSLHandshake/i.test(
      text,
    )
  )
    return "dependency-download"
  if (/problem occurred (?:evaluating|configuring)|configuration.*failed|plugin.*not found/i.test(text))
    return "gradle-configuration"
  if (/compilation (?:error|failed)|compileKotlin.*FAILED|compileTestKotlin.*FAILED/i.test(text)) return "compilation"
  if (/there were failing tests|\(fail\)|test.*FAILED/i.test(text)) return "test-execution"
  if (/could not create the java virtual machine|java_home.*invalid|permission denied|cannot execute/i.test(text))
    return "process-start"
  return "unclassified"
}

export async function main(args = process.argv.slice(2)) {
  const [platform, out] = args
  if (!platform || !out) throw new Error("target-arguments-required")
  const root = path.resolve(import.meta.dir, "../../..")
  const items: Item[] = []
  for (const suite of commands(platform)) {
    const cwd = path.join(root, suite.cwd)
    const start = Date.now()
    const result = await capture(suite.argv, {
      cwd,
      timeout: platform === "macos" ? 1_800_000 : 300_000,
      env: {
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_TEST_PROFILE: platform === "macos" ? "darwin" : "",
        TURBO_FORCE: "true",
        GRADLE_OPTS: "-Dorg.gradle.daemon=false",
      },
    }).catch(() => undefined)
    const text = result ? result.stdout + "\n" + result.stderr : ""
    const test = platform === "windows" || suite.id === "jetbrains-boundaries"
    const count = platform === "windows" ? counts(text) : test ? await junit(cwd, start) : undefined
    const failed =
      !result || result.code !== 0 || result.timeout || (test && (!count || count.passed === 0 || count.failed > 0))
    items.push({
      id: `targeted:${platform}:${suite.id}`,
      status: failed ? "FAIL" : "PASS",
      evidence: "CURRENT_EXECUTABLE",
      reason: failed
        ? "Targeted diagnostic command failed or lacked executed test evidence"
        : "Targeted diagnostic command passed",
      commands: [suite.argv.map((arg) => (arg === process.execPath ? "bun" : arg))],
      exit: result?.code,
      details: {
        ...count,
        ...(platform === "macos" ? { stage: result ? stage(text, result.code) : "process-start" } : {}),
        category: category(result, text),
        timeout: result?.timeout ?? false,
        failedTests: platform === "windows" ? await diagnostic(text, root, cwd) : [],
      },
    })
    await save(out, items, { qualificationSha: revision, originatingRun: "37552045709", targetedOnly: true })
    console.log(`${suite.id}: ${failed ? "FAIL" : "PASS"}`)
  }
  if (items.some((item) => item.status === "FAIL")) process.exitCode = 1
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("targeted-diagnostic-helper-failed")
    process.exitCode = 1
  })
}
