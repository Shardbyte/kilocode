export type Suite = {
  id: string
  cwd: string
  argv: string[]
  platform: "cross-platform" | "linux-only" | "windows-specific" | "macos-specific"
  reason: string
}

const bun = process.execPath
const suite = (
  id: string,
  cwd: string,
  files: string[],
  platform: Suite["platform"] = "cross-platform",
  reason = "Portable data, authority, request and serialization tests",
): Suite => ({ id, cwd, argv: [bun, "test", ...files], platform, reason })

export const portable: Suite[] = [
  suite("core", "packages/core", [
    "test/kilocode/provider-account-profiles.test.ts",
    "test/kilocode/session-binding.test.ts",
    "test/kilocode/provider-profile-dispatch.test.ts",
    "--timeout",
    "60000",
  ]),
  suite("authority", "packages/opencode", [
    "test/kilocode/provider/utility-account.test.ts",
    "test/kilocode/cli/utility-account.test.ts",
    "test/kilocode/enhance-prompt-authority.test.ts",
    "test/kilocode/commit-message-authority.test.ts",
    "--timeout",
    "60000",
  ]),
  suite("schemas", "packages/opencode", [
    "test/kilocode/qualification/client-protocol.test.ts",
    "test/kilocode/task-profile-order.test.ts",
    "--timeout",
    "60000",
  ]),
  suite("sdk", "packages/sdk/js", [
    "test/kilocode/utility-account.test.ts",
    "test/kilocode/provider-account-usage.test.ts",
    "test/session-history.test.ts",
    "test/generated-session-status.test.ts",
  ]),
]

export const linux: Suite[] = [
  suite(
    "qualification",
    "packages/opencode",
    [
      "test/kilocode/qualification",
      "test/kilocode/session-authority-qualification.test.ts",
      "test/kilocode/session-profile-error.test.ts",
      "test/kilocode/session-error-logs.test.ts",
      "test/kilocode/session-processor-network-offline.test.ts",
      "test/kilocode/provider/utility-authority-lifecycle.test.ts",
      "test/kilocode/provider/utility-account.test.ts",
      "test/kilocode/utility-runtime-authority.test.ts",
      "test/kilocode/enhance-prompt-authority.test.ts",
      "test/kilocode/commit-message-authority.test.ts",
      "test/kilocode/agent-generation-authority.test.ts",
      "test/kilocode/compaction-account-authority.test.ts",
      "test/kilocode/cli/utility-account.test.ts",
      "test/kilocode/branch-name.test.ts",
      "test/kilocode/session-title-generation.test.ts",
      "test/kilocode/memory/memory-ports.test.ts",
      "test/kilocode/memory/memory-integration.test.ts",
      "test/kilocode/task-profile-order.test.ts",
    ],
    "linux-only",
    "Exact validated M10 group; terminal capture, source archives and hard lifecycle fixtures are qualified on Linux",
  ),
  suite(
    "core-full",
    "packages/core",
    [
      "--timeout",
      "60000",
      "test/credential.test.ts",
      "test/event.test.ts",
      "test/kilocode-provider-usage-codex.test.ts",
      "test/kilocode/provider-account-profiles.test.ts",
      "test/kilocode/provider-profile-dispatch.test.ts",
      "test/kilocode/provider-profile-refresh.test.ts",
      "test/kilocode/session-binding.test.ts",
      "test/database-migration.test.ts",
      "test/kilocode/provider-profile-qualification.test.ts",
      "test/kilocode/qualification-migration.test.ts",
      "test/kilocode/provider-profile-history-qualification.test.ts",
      "test/kilocode/provider-profile-admission-qualification.test.ts",
    ],
    "linux-only",
    "Exact validated core history/migration/process group; archive and POSIX permission assertions are not claimed portable",
  ),
  suite(
    "aggregate",
    "packages/opencode",
    [
      "test/provider",
      "test/session/llm.test.ts",
      "test/session/llm-native.test.ts",
      "test/session/llm-native-recorded.test.ts",
      "test/plugin/codex.test.ts",
      "test/kilocode/codex-auth-refresh.test.ts",
      "test/kilocode/codex-refresh-user-agent.test.ts",
      "test/kilocode/provider/codex-oauth.test.ts",
      "test/kilocode/provider/codex-profile.test.ts",
      "test/kilocode/session-resume-integration.test.ts",
      "test/tool/task.test.ts",
    ],
    "linux-only",
    "Exact previously failing single-process aggregate; run after the full qualification group without retry",
  ),
  {
    id: "sdk-full",
    cwd: "packages/sdk/js",
    argv: [bun, "test"],
    platform: "cross-platform",
    reason: "Generated SDK tests",
  },
  {
    id: "sdk-types",
    cwd: "packages/sdk/js",
    argv: [bun, "run", "typecheck"],
    platform: "cross-platform",
    reason: "Generated contract typecheck",
  },
  {
    id: "backend-types",
    cwd: "packages/opencode",
    argv: [bun, "run", "typecheck"],
    platform: "cross-platform",
    reason: "Affected backend typecheck",
  },
]

export const clients: Suite[] = [
  suite("vscode", "packages/kilo-vscode", [
    "tests/unit/qualification-client-boundary.test.ts",
    "tests/unit/utility-account.test.ts",
    "tests/unit/provider-accounts.test.ts",
    "tests/unit/kilo-provider-utility-enhance.test.ts",
    "tests/unit/kilo-provider-utils-enhance-error.test.ts",
    "tests/unit/model-selector-utils.test.ts",
    "src/services/commit-message/__tests__/index.spec.ts",
    "tests/unit/worktree-manager.test.ts",
    "tests/unit/git-ops.test.ts",
    "--timeout",
    "60000",
  ]),
  ...["packages/opencode", "packages/core", "packages/sdk/js", "packages/kilo-vscode"].map(
    (cwd): Suite => ({
      id: `${cwd.split("/").at(-1)}-types`,
      cwd,
      argv: [bun, "run", "typecheck"],
      platform: "cross-platform",
      reason: "Affected package typecheck",
    }),
  ),
  suite(
    "windows-worktree",
    "packages/kilo-vscode",
    [
      "tests/unit/worktree-manager.test.ts",
      "--test-name-pattern",
      "keeps a Windows worktree tracked while a live process locks its directory",
      "--timeout",
      "30000",
    ],
    "windows-specific",
    "Existing real Windows process-lock cleanup regression",
  ),
  suite(
    "darwin-profile",
    "packages/opencode",
    ["test/kilocode/test-profile.test.ts"],
    "macos-specific",
    "Validate the existing Darwin test-profile policy, without claiming its excluded files ran",
  ),
]

export function jetbrains(platform: string): Suite[] {
  if (platform === "linux")
    return [
      {
        id: "jetbrains-full",
        cwd: "packages/kilo-jetbrains",
        argv: [bun, "script/test-ci.ts"],
        platform: "linux-only",
        reason: "Existing repository-native full JetBrains CI runner",
      },
      {
        id: "jetbrains-types",
        cwd: "packages/kilo-jetbrains",
        argv: ["./gradlew", "typecheck", "--no-daemon"],
        platform: "cross-platform",
        reason: "Java 21 Gradle typecheck",
      },
    ]
  const base = platform === "windows" ? ["cmd.exe", "/c", "gradlew.bat"] : ["./gradlew"]
  return [
    {
      id: "jetbrains-boundaries",
      cwd: "packages/kilo-jetbrains",
      argv: [
        ...base,
        ":backend:test",
        "--tests",
        "ai.kilocode.backend.app.KiloBackendChatManagerTest",
        "--tests",
        "ai.kilocode.backend.app.QualificationClientBoundaryTest",
        ":frontend:test",
        "--tests",
        "ai.kilocode.client.session.controller.PromptEnhancerTest",
        "--tests",
        "ai.kilocode.client.session.controller.QualificationClientBoundaryTest",
        "--rerun-tasks",
        "--no-daemon",
        "--console=plain",
      ],
      platform: "cross-platform",
      reason: "Focused current account-context/reconnect tests; preserve real Gradle failure on Windows",
    },
    {
      id: "jetbrains-types",
      cwd: "packages/kilo-jetbrains",
      argv: [...base, "typecheck", "--no-daemon"],
      platform: "cross-platform",
      reason: "Java 21 Gradle typecheck",
    },
  ]
}
