import { expect, test } from "bun:test"
import path from "node:path"
import { checkpoints } from "./history"

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = {
  "runs-on": string
  if?: string
  needs?: string[]
  strategy?: { "fail-fast": boolean; matrix: { include?: { platform: string; runner: string }[]; sha?: string[] } }
  steps: Step[]
}
const file = path.resolve(import.meta.dir, "../../../.github/workflows/provider-account-qualification.yml")
const workflow = Bun.YAML.parse(await Bun.file(file).text()) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

test("qualification runs only on manual dispatch or explicit qualification tags", () => {
  expect(workflow.on).toEqual({ workflow_dispatch: null, push: { tags: ["provider-account-qualification-*"] } })
  expect(workflow.on.push).not.toHaveProperty("branches")
  expect(workflow.on.push).not.toHaveProperty("branches-ignore")
  for (const event of ["pull_request", "pull_request_target", "schedule", "repository_dispatch"]) {
    expect(workflow.on).not.toHaveProperty(event)
  }
})

test("qualification workflow keeps least privilege and uses standard hosted platform matrices", () => {
  expect(workflow.permissions).toEqual({ contents: "read" })
  const matrix = [
    { platform: "linux", runner: "ubuntu-24.04" },
    { platform: "windows", runner: "windows-2025" },
    { platform: "macos", runner: "macos-15" },
  ]
  for (const id of ["current-platform", "jetbrains-current"]) {
    expect(workflow.jobs[id]?.strategy?.matrix.include).toEqual(matrix)
    expect(workflow.jobs[id]?.strategy?.["fail-fast"]).toBe(false)
  }
  expect(workflow.jobs["historical-audit"]?.strategy?.matrix.sha).toEqual(checkpoints.map((item) => item.sha))
  for (const job of Object.values(workflow.jobs)) {
    expect(["ubuntu-24.04", "${{ matrix.runner }}"]).toContain(job["runs-on"])
    expect(JSON.stringify(job)).not.toContain("continue-on-error")
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    expect(checkout?.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false })
  }
})

test("workflow separates historical protocols and known gaps and always aggregates available artifacts", () => {
  expect(workflow.jobs["historical-protocol"]?.steps.some((step) => step.run?.endsWith("skew.ts protocol"))).toBe(true)
  expect(workflow.jobs["historical-cli-skew"]?.steps.some((step) => step.run?.endsWith("skew.ts cli"))).toBe(true)
  for (const client of ["vscode", "jetbrains"]) {
    expect(
      workflow.jobs[`historical-${client}`]?.steps.some((step) => step.run?.includes(`gui.ts deferred ${client}`)),
    ).toBe(true)
  }
  const aggregate = workflow.jobs.aggregate!
  expect(aggregate.if).toBe("always()")
  expect(aggregate.needs?.toSorted()).toEqual(
    Object.keys(workflow.jobs)
      .filter((id) => id !== "aggregate")
      .toSorted(),
  )
  expect(aggregate.steps.find((step) => step.run?.includes("run.ts aggregate"))?.if).toBe("always()")
  expect(aggregate.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with?.name).toBe(
    "provider-account-qualification-summary",
  )
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))) {
      expect(step.if).toBe("always()")
      expect(String(step.with?.path)).toEndWith(".json")
    }
    for (const step of job.steps.filter((step) => step.run?.includes("provider-account-qualification/"))) {
      expect(step.env).toMatchObject({
        GITHUB_SHA: "${{ github.sha }}",
        QUALIFICATION_RUNNER_OS: "${{ runner.os }}",
        QUALIFICATION_RUNNER_ARCH: "${{ runner.arch }}",
      })
    }
  }
})
