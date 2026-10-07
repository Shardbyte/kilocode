import { expect, test } from "bun:test"
import { commands, stage } from "./targeted"
import path from "node:path"

test("Windows diagnostics execute only three allowlisted files independently and together", () => {
  const suites = commands("windows")
  expect(suites).toHaveLength(4)
  expect(suites.slice(0, 3).map((suite) => suite.argv.slice(2, -2))).toEqual([
    ["src/services/commit-message/__tests__/index.spec.ts"],
    ["tests/unit/worktree-manager.test.ts"],
    ["tests/unit/git-ops.test.ts"],
  ])
  expect(suites.at(-1)?.argv.slice(2, -2)).toEqual(suites.slice(0, 3).map((suite) => suite.argv.at(2)!))
  expect(suites.every((suite) => suite.cwd === "packages/kilo-vscode")).toBe(true)
  expect(() => commands("linux")).toThrow("target-platform-not-allowlisted")
})

test("macOS diagnostics contain only focused boundaries and typecheck", () => {
  const suites = commands("macos")
  expect(suites.map((suite) => suite.id)).toEqual(["jetbrains-boundaries", "jetbrains-types"])
  expect(suites.at(0)?.argv).toContain("--tests")
  expect(suites.at(1)?.argv).toEqual(["./gradlew", "typecheck", "--no-daemon"])
  expect(suites.every((suite) => suite.cwd === "packages/kilo-jetbrains")).toBe(true)
})

test("process stages publish fixed codes rather than captured diagnostics", () => {
  for (const [text, expected] of [
    ["fatal: detected dubious ownership", "repository-safety"],
    ["fatal: not a git repository", "git-metadata"],
    ["Could not resolve dependency", "dependency-download"],
    ["A problem occurred configuring root project", "gradle-configuration"],
    ["Compilation failed", "compilation"],
    ["There were failing tests", "test-execution"],
    ["Could not create the Java virtual machine", "process-start"],
    ["unrecognized diagnostic", "unclassified"],
  ]) {
    expect(stage(text!, 1)).toBe(expected!)
  }
  expect(stage("unrecognized diagnostic", 0)).toBe("completed")
})

test("diagnostic branch template has no full campaign or automatic trigger", async () => {
  const file = path.resolve(
    import.meta.dir,
    "../../../.github/workflows/disabled/provider-account-targeted-attribution.yml.disabled",
  )
  const workflow = Bun.YAML.parse(await Bun.file(file).text()) as {
    on: Record<string, unknown>
    permissions: Record<string, string>
    jobs: Record<
      string,
      { if: string; "runs-on": string; steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] }
    >
  }
  expect(workflow.on).toEqual({ workflow_dispatch: null })
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(Object.keys(workflow.jobs)).toEqual(["history", "windows", "macos"])
  expect(workflow.jobs.history?.["runs-on"]).toBe("ubuntu-24.04")
  expect(workflow.jobs.windows?.["runs-on"]).toBe("windows-2025")
  expect(workflow.jobs.macos?.["runs-on"]).toBe("macos-15")
  for (const [platform, job] of Object.entries(workflow.jobs)) {
    expect(job.if).toBe("startsWith(github.ref, 'refs/heads/diagnostic/provider-account-run2-')")
    expect(job.steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      platform === "history"
        ? 'bun run script/kilocode/provider-account-qualification/history-targeted.ts "${{ runner.temp }}/history-targeted.json"'
        : `bun run script/kilocode/provider-account-qualification/targeted.ts ${platform} "\${{ runner.temp }}/targeted-${platform}.json"`,
    ])
    expect(job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(
      false,
    )
    expect(job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with?.path).toBe(
      platform === "history"
        ? "${{ runner.temp }}/history-targeted.json"
        : `\${{ runner.temp }}/targeted-${platform}.json`,
    )
  }
})
