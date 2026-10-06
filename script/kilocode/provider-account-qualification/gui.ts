import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { capture, save, type Item } from "./evidence"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const targets = {
  vscode: {
    sha: "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12",
    pkg: "packages/kilo-vscode",
    files: [
      "packages/kilo-vscode/package.json",
      "packages/kilo-vscode/src/provider-accounts.ts",
      "packages/kilo-vscode/tests/unit/provider-accounts.test.ts",
    ],
  },
  jetbrains: {
    sha: "f2ad10f5c6c67052940bf19f14ceacf28add6b9d",
    pkg: "packages/kilo-jetbrains",
    files: [
      "packages/kilo-jetbrains/build.gradle.kts",
      "packages/kilo-jetbrains/gradle/libs.versions.toml",
      "packages/kilo-jetbrains/backend/src/test/kotlin/ai/kilocode/backend/app/KiloBackendChatManagerTest.kt",
      "packages/kilo-jetbrains/backend/src/test/kotlin/ai/kilocode/backend/app/QualificationClientBoundaryTest.kt",
      "packages/kilo-jetbrains/frontend/src/test/kotlin/ai/kilocode/client/session/controller/PromptEnhancerTest.kt",
    ],
  },
} as const

type Step = {
  status: "PASS" | "FAIL" | "NOT_RUN"
  command: string[] | null
  exitCode: number | null
  output: "exit-0" | "nonzero-exit" | "timeout" | "not-applicable" | "not-run"
  reason: string
}

async function output(argv: string[], cwd: string) {
  const result = await capture(argv, { cwd, timeout: 10_000 })
  return { code: result.code, text: result.stdout.trim().slice(0, 120) }
}

async function run(argv: string[], cwd: string, limit = 1_200_000): Promise<Step> {
  const result = await capture(argv, { cwd, timeout: limit })
  const timed = result.timeout
  const code = result.code
  return {
    status: timed ? "FAIL" : code === 0 ? "PASS" : "FAIL",
    command: argv,
    exitCode: code,
    output: timed ? "timeout" : code === 0 ? "exit-0" : "nonzero-exit",
    reason: timed ? "command-timeout" : code === 0 ? "exit-0" : "command-failed",
  }
}

function skipped(reason: string): Step {
  return { status: "NOT_RUN", command: null, exitCode: null, output: "not-run", reason }
}

async function digest(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
}

async function hashes(dir: string, files: readonly string[]) {
  return Promise.all(
    files.map(async (file) => {
      const full = path.join(dir, file)
      return { path: file, sha256: existsSync(full) ? await digest(full) : null }
    }),
  )
}

async function persist(
  dest: string,
  kind: keyof typeof targets,
  sha: string,
  value: {
    build: Step
    accountTests: Step
    guiFlow: Step
    classification: string
    provenance?: Record<string, unknown>
  } & Record<string, unknown>,
) {
  const items: Item[] = (["build", "accountTests", "guiFlow"] as const).map((key) => {
    const step = value[key]
    return {
      id: `historical-${kind}:${key}`,
      status: step.status,
      evidence:
        step.status === "NOT_RUN"
          ? "NOT_RUN"
          : key === "build" && step.status === "PASS" && value.classification === "REBUILDABLE"
            ? "HISTORICAL_REBUILT"
            : "SOURCE_INSPECTION",
      reason: step.reason,
      source: { commit: sha },
      commands: step.command ? [step.command] : undefined,
      exit: step.exitCode ?? undefined,
      details: { output: step.output, classification: value.classification, provenance: value.provenance },
    }
  })
  await save(dest, items, { client: kind, source: { commit: sha }, details: value })
}

async function record(kind: keyof typeof targets, sha: string, dir: string, dest: string) {
  const target = targets[kind]
  if (sha !== target.sha) throw new Error("unsupported-historical-checkpoint")
  const src = path.resolve(dir)
  if (src === root || src.startsWith(`${root}${path.sep}`))
    throw new Error("historical-source-must-be-outside-checkout")
  const pkg = path.join(src, target.pkg)
  await mkdir(path.dirname(path.resolve(dest)), { recursive: true })

  const evidence = {
    schema: 1,
    client: kind,
    sha,
    source: existsSync(pkg) ? "AVAILABLE" : "UNAVAILABLE",
    sourceVersion: null as string | null,
    sourceFiles: await hashes(src, target.files),
    manifest: {
      packageManager: null as string | null,
      engine: null as string | null,
      desktopHarness: null as string | null,
      desktopTestCommand: null as string | null,
      gradleWrapper: null as string | null,
      javaToolchain: null as string | null,
      idePlatform: null as string | null,
    },
    runtimes: {} as Record<string, { version: string | null; exitCode: number }>,
    preconditions: {
      display: Boolean(process.env.DISPLAY),
      xvfbRun: existsSync("/usr/bin/xvfb-run"),
      gitMetadata: existsSync(path.join(src, ".git")),
      testElectronDeclared: false,
      cliBundleObserved: false,
    },
    build: skipped("source-unavailable"),
    accountTestsTier: "SOURCE_PROTOCOL",
    accountTests: skipped("source-unavailable"),
    guiFlow: skipped("source-unavailable"),
    classification: "SOURCE_ONLY" as "EXECUTABLE" | "REBUILDABLE" | "SOURCE_ONLY" | "UNAVAILABLE",
    reason: "source-unavailable",
    provenance: {} as Record<string, unknown>,
  }
  if (!existsSync(pkg)) {
    evidence.classification = "UNAVAILABLE"
    await persist(dest, kind, sha, evidence)
    return evidence
  }

  const bun = await output([process.execPath, "--version"], src)
  evidence.runtimes.bun = { version: bun.code === 0 ? bun.text : null, exitCode: bun.code }
  const node = await output(["node", "--version"], src)
  evidence.runtimes.node = { version: node.code === 0 ? node.text : null, exitCode: node.code }
  const pkgData = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8")) as {
    version?: string
    engines?: { vscode?: string }
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  evidence.sourceVersion = pkgData.version ?? "not-declared"
  const top = JSON.parse(await readFile(path.join(src, "package.json"), "utf8")) as { packageManager?: string }
  evidence.manifest.packageManager = top.packageManager ?? null

  if (kind === "vscode") {
    evidence.preconditions.testElectronDeclared = Boolean(pkgData.devDependencies?.["@vscode/test-electron"])
    evidence.manifest.engine = pkgData.engines?.vscode ?? null
    evidence.manifest.desktopHarness = pkgData.devDependencies?.["@vscode/test-electron"] ?? null
    evidence.manifest.desktopTestCommand = pkgData.scripts?.test ?? null
    evidence.build = await run([process.execPath, "run", "compile"], pkg, 1_800_000)
    const ver = path.join(pkg, "node_modules", ".kilo-cli-version")
    const info = existsSync(ver) ? (JSON.parse(await readFile(ver, "utf8")) as { kind?: string }) : undefined
    evidence.preconditions.cliBundleObserved =
      info?.kind === "compiled" && existsSync(path.join(pkg, "bin", process.platform === "win32" ? "kilo.exe" : "kilo"))
    const test = "tests/unit/provider-accounts.test.ts"
    evidence.accountTests = existsSync(path.join(pkg, test))
      ? await run([process.execPath, "test", test], pkg)
      : skipped("historical-account-test-file-absent")
    evidence.guiFlow = skipped(
      evidence.preconditions.testElectronDeclared
        ? "no-provider-account-desktop-flow-test"
        : "desktop-test-harness-absent",
    )
  } else {
    const gradle = path.join(pkg, "gradlew")
    const wrap = path.join(pkg, "gradle/wrapper/gradle-wrapper.properties")
    const build = await readFile(path.join(pkg, "build.gradle.kts"), "utf8")
    const libs = await readFile(path.join(pkg, "gradle/libs.versions.toml"), "utf8")
    evidence.manifest.gradleWrapper = (await readFile(wrap, "utf8")).match(/^distributionUrl=(.*)$/m)?.[1] ?? null
    evidence.manifest.javaToolchain = build.match(/jvmToolchain\((\d+)\)/)?.[1] ?? null
    evidence.manifest.idePlatform = libs.match(/^intellij-platform\s*=\s*"([^"]+)"/m)?.[1] ?? null
    const hasBoundary = existsSync(
      path.join(pkg, "backend/src/test/kotlin/ai/kilocode/backend/app/QualificationClientBoundaryTest.kt"),
    )
    const hasChat = existsSync(
      path.join(pkg, "backend/src/test/kotlin/ai/kilocode/backend/app/KiloBackendChatManagerTest.kt"),
    )
    const hasPrompt = existsSync(
      path.join(pkg, "frontend/src/test/kotlin/ai/kilocode/client/session/controller/PromptEnhancerTest.kt"),
    )
    const buildArgs = [gradle, "buildPlugin", "--no-daemon", "--console=plain"]
    evidence.build = existsSync(gradle) ? await run(buildArgs, pkg) : skipped("gradle-wrapper-absent")
    const tests = [
      ...(hasBoundary ? [":backend:test", "--tests", "ai.kilocode.backend.app.QualificationClientBoundaryTest"] : []),
      ...(hasChat ? [":backend:test", "--tests", "ai.kilocode.backend.app.KiloBackendChatManagerTest"] : []),
      ...(hasPrompt ? [":frontend:test", "--tests", "ai.kilocode.client.session.controller.PromptEnhancerTest"] : []),
    ]
    evidence.accountTests =
      tests.length > 0 && existsSync(gradle)
        ? await run([gradle, ...tests, "--no-daemon", "--console=plain"], pkg)
        : skipped("historical-account-context-tests-absent")
    evidence.guiFlow = skipped("no-provider-account-desktop-flow-test")
  }

  if (evidence.build.status === "PASS" && (kind === "jetbrains" || evidence.preconditions.cliBundleObserved)) {
    evidence.classification = "REBUILDABLE"
    evidence.reason = kind === "vscode" ? "historical-extension-compile-passed" : "historical-plugin-build-passed"
  } else {
    evidence.classification = "SOURCE_ONLY"
    evidence.reason =
      evidence.build.status === "PASS"
        ? "required-cli-binary-not-observed"
        : !evidence.preconditions.gitMetadata
          ? "historical-git-metadata-absent"
          : evidence.build.reason
    if (!evidence.preconditions.gitMetadata && evidence.build.status === "FAIL") {
      evidence.build.reason = "historical-git-metadata-absent"
      if (evidence.accountTests.status === "FAIL") evidence.accountTests.reason = "historical-git-metadata-absent"
    }
  }
  evidence.provenance = {
    sourceSha: sha,
    gitMetadata: evidence.preconditions.gitMetadata,
    build: evidence.build.reason,
  }
  await persist(dest, kind, sha, evidence)
  if (evidence.build.status === "FAIL" || evidence.accountTests.status === "FAIL")
    throw new Error("historical-helper-execution-failed")
  return evidence
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "deferred") return deferred(args[1] as keyof typeof targets, args[2] ?? "")
  const [kind, sha, dir, dest] = args
  if ((kind !== "vscode" && kind !== "jetbrains") || !sha || !dir || !dest) {
    throw new Error("usage: gui.ts <vscode|jetbrains> <historical-sha> <source-dir> <out>")
  }
  return record(kind, sha, dir, dest)
}

async function deferred(kind: keyof typeof targets, out: string) {
  if (!(kind in targets) || !out) throw new Error("usage: gui.ts deferred <vscode|jetbrains> <out>")
  const target = targets[kind]
  const result = {
    classification: "SOURCE_ONLY",
    provenance: {
      sourceSha: target.sha,
      sourceVersion: "7.8.3",
      origin: "local-worker-feasibility-audit",
      archivedGitMetadata: false,
      observedBuildExit: 1,
      observedAccountTests: kind === "vscode" ? "PASS source helper tests only" : "FAIL Gradle configuration",
      buildFailure: "historical-git-metadata-absent",
    },
    build: skipped(
      "Historical archived build exited 1 because Git metadata was absent; no rebuild established; hosted build not attempted",
    ),
    accountTests: skipped(
      kind === "vscode"
        ? "Local historical provider-account helper tests passed; hosted helper tests not run and no desktop-flow coverage established"
        : "Local focused Gradle account-context tests failed at configuration because Git metadata was absent; hosted tests not run",
    ),
    guiFlow: skipped(
      "No provider-account desktop-flow executable path established; historical desktop behavior is not asserted",
    ),
  }
  await persist(out, kind, target.sha, result)
  return result
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.name : "Error")
    process.exitCode = 1
  })
}
