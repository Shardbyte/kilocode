import { readFile } from "node:fs/promises"
import path from "node:path"
import { capture, metadata, save } from "./evidence"
import { counts, diagnostic } from "./run"
import { linux } from "./suites"

const source = "989d187754823520591a6d22c3049788279ee759"
const root = path.resolve(import.meta.dir, "../../..")
const titles = [
  {
    file: "test/kilocode/qualification/caller-failures.test.ts",
    name: "Agent.generate and roll-call fail safely for real SDK errors and captured production output",
  },
  {
    file: "test/kilocode/qualification/utility-inference.test.ts",
    name: "commit-message utility generation failure logs the actual sanitized error line",
  },
] as const

export function passed(text: string) {
  const lines = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
  const found = new Set<string>()
  let file = ""
  for (const line of lines) {
    const head = /^\s*(.+\.test\.[cm]?[jt]sx?):\s*$/.exec(line)
    if (head) {
      file = head[1]!.replaceAll("\\", "/").split("/").slice(-4).join("/")
      continue
    }
    const target = titles.find((item) => file.endsWith(item.file) && line.includes(`(pass) ${item.name} [`))
    if (target) found.add(target.name)
  }
  return [...found]
}

export function summarize(input: {
  code: number | undefined
  timeout: boolean
  count: ReturnType<typeof counts>
  failed: Awaited<ReturnType<typeof diagnostic>>
  passedTitles: string[]
  metadataOK: boolean
}) {
  const named = titles.map((title) => input.passedTitles.includes(title.name))
  const failures = input.failed.filter((item) =>
    titles.some((title) => title.file === item.file && title.name === item.name),
  )
  const category = !input.metadataOK
    ? "metadata-mismatch"
    : input.code == null
      ? "setup-failure"
      : input.timeout
        ? "timeout"
        : input.count == null
          ? "denominator-unverified"
          : input.count.passed + input.count.failed + input.count.skipped !== 137 || input.count.skipped !== 0
            ? "denominator-mismatch"
            : input.count.failed > 0 || input.code !== 0
              ? input.count.failed > 0
                ? "test-failure"
                : "unexpected-failure"
              : input.failed.length > 0
                ? "unexpected-failure"
                : named.some((value) => !value)
                  ? "evidence-incomplete"
                  : "none"
  const pass =
    input.code === 0 &&
    !input.timeout &&
    input.metadataOK &&
    input.count?.passed === 137 &&
    input.count.failed === 0 &&
    input.count.skipped === 0 &&
    input.failed.length === 0 &&
    named.every(Boolean)
  return {
    status: pass ? "PASS" : "FAIL",
    category,
    utilityChildPassed: null,
    callerPassed: named[0] && !failures.some((item) => item.file === titles[0].file),
    utilityInferencePassed: named[1] && !failures.some((item) => item.file === titles[1].file),
    childEvidence: "unknown-from-parent-suite",
    passed: input.count?.passed,
    failed: input.count?.failed,
    skipped: input.count?.skipped,
    assertions: input.count?.assertions,
    exit: input.code,
    timeout: input.timeout,
    metadataOK: input.metadataOK,
    failedFiles: input.failed.map((item) => ({
      file: item.file,
      ...(titles.some((title) => title.file === item.file && title.name === item.name) ? { title: item.name } : {}),
      category: item.category,
    })),
  }
}

async function main() {
  const expectedHead = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/.test(expectedHead ?? "")) throw new Error("diagnostic-checkout-sha-mismatch")
  const head = await capture(["git", "rev-parse", "HEAD"], { cwd: root, timeout: 10_000 })
  if (head.code !== 0 || head.timeout || head.stdout.trim() !== expectedHead)
    throw new Error("diagnostic-head-mismatch")
  const parent = await capture(["git", "rev-parse", "HEAD^"], { cwd: root, timeout: 10_000 })
  if (parent.code !== 0 || parent.timeout || parent.stdout.trim() !== source)
    throw new Error("canonical-parent-mismatch")
  const changed = await capture(
    [
      "git",
      "diff",
      "--name-only",
      source,
      "--",
      "packages",
      ".github/actions",
      ".github/workflows/provider-account-qualification.yml",
      "script/kilocode/provider-account-qualification",
      ":(exclude)script/kilocode/provider-account-qualification/m10-hosted-confirmation.ts",
      ":(exclude)script/kilocode/provider-account-qualification/m10-hosted-confirmation.test.ts",
    ],
    { cwd: root, timeout: 10_000 },
  )
  if (changed.code !== 0 || changed.timeout || changed.stdout.trim()) throw new Error("canonical-source-drift")
  const cached = await capture(
    [
      "git",
      "diff",
      "--cached",
      "--name-only",
      source,
      "--",
      "packages",
      ".github/actions",
      ".github/workflows/provider-account-qualification.yml",
      "script/kilocode/provider-account-qualification",
      ":(exclude)script/kilocode/provider-account-qualification/m10-hosted-confirmation.ts",
      ":(exclude)script/kilocode/provider-account-qualification/m10-hosted-confirmation.test.ts",
    ],
    { cwd: root, timeout: 10_000 },
  )
  if (cached.code !== 0 || cached.timeout || cached.stdout.trim()) throw new Error("canonical-source-drift")

  const suite = linux.find((item) => item.id === "qualification")
  if (!suite || suite.cwd !== "packages/opencode") throw new Error("canonical-suite-unavailable")
  for (const title of titles) {
    const text = await readFile(path.join(root, suite.cwd, title.file), "utf8")
    if (!text.includes(JSON.stringify(title.name))) throw new Error("source-attested-title-missing")
  }

  const out = process.argv[2]
  if (!out) throw new Error("evidence-path-required")
  const meta = await metadata()
  const metadataOK =
    process.env.QUALIFICATION_RUNNER_OS === "Linux" &&
    process.env.QUALIFICATION_RUNNER_ARCH === "X64" &&
    process.env.ImageOS === "ubuntu24" &&
    Bun.version === "1.4.2" &&
    meta.os === "linux" &&
    meta.arch === "x64"
  const result = metadataOK
    ? await capture(suite.argv, {
        cwd: path.join(root, suite.cwd),
        timeout: 900_000,
        env: {
          KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          KILO_TEST_PROFILE: "",
          TURBO_FORCE: "true",
          GRADLE_OPTS: "-Dorg.gradle.daemon=false",
        },
      }).catch(() => undefined)
    : undefined
  const text = result ? result.stdout + "\n" + result.stderr : ""
  const count = result ? counts(text) : undefined
  const failed = result ? await diagnostic(text, root, path.join(root, suite.cwd)) : []
  const passedTitles = passed(text)
  const summary = summarize({
    code: result?.code,
    timeout: result?.timeout ?? false,
    count,
    failed,
    passedTitles,
    metadataOK,
  })
  await save(out, [], {
    canonical_source_sha: source,
    diagnostic_sha: expectedHead,
    checked_out_sha: expectedHead,
    workflow_run_id: process.env.GITHUB_RUN_ID ?? "local",
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
    runnerOS: process.env.QUALIFICATION_RUNNER_OS ?? "unknown",
    runnerArch: process.env.QUALIFICATION_RUNNER_ARCH ?? "unknown",
    image: process.env.ImageOS === "ubuntu24" ? "ubuntu-24.04" : "unavailable",
    bun: Bun.version,
    argv: suite.argv,
    counts: {
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      assertions: summary.assertions,
    },
    exit: summary.exit,
    timeout: summary.timeout,
    status: summary.status,
    category: summary.category,
    metadataOK: summary.metadataOK,
    utilityChildPassed: summary.utilityChildPassed,
    callerPassed: summary.callerPassed,
    utilityInferencePassed: summary.utilityInferencePassed,
    childEvidence: summary.childEvidence,
    failedFiles: summary.failedFiles,
  })
  if (summary.status !== "PASS") process.exitCode = 1
}

if (import.meta.main) {
  await main().catch(async () => {
    const out = process.argv[2]
    if (out) {
      await save(out, [], {
        canonical_source_sha: source,
        diagnostic_sha: process.env.GITHUB_SHA ?? "unknown",
        workflow_run_id: process.env.GITHUB_RUN_ID ?? "local",
        run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
        runnerOS: process.env.QUALIFICATION_RUNNER_OS ?? "unknown",
        runnerArch: process.env.QUALIFICATION_RUNNER_ARCH ?? "unknown",
        image: process.env.ImageOS === "ubuntu24" ? "ubuntu-24.04" : "unavailable",
        bun: Bun.version,
        status: "FAIL",
        category: "setup-failure",
      }).catch(() => {
        console.error("m10-hosted-confirmation-evidence-failed")
      })
    }
    console.error("m10-hosted-confirmation-failed")
    process.exitCode = 1
  })
}
