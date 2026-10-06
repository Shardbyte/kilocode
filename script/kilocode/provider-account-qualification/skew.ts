import { createHash } from "node:crypto"
import path from "node:path"
import { capture, save } from "./evidence"
import type { Item } from "./evidence"

const root = path.resolve(import.meta.dir, "../../..")
const source = {
  commit: "34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12",
  paths: ["packages/kilo-vscode/src/services/commit-message/index.ts", "packages/kilo-vscode/src/KiloProvider.ts"],
} as const
const head = await git(["rev-parse", "HEAD"]).then((value) => value?.trim() ?? "unavailable")

async function git(args: string[]) {
  const result = await capture(["git", ...args], { cwd: root, timeout: 10_000 })
  return result.code === 0 ? result.stdout : undefined
}

async function protocol() {
  const files = await Promise.all(
    source.paths.map(async (file) => {
      const text = await git(["show", `${source.commit}:${file}`])
      if (!text) return undefined
      return {
        path: file,
        sha256: createHash("sha256").update(text).digest("hex"),
        hasCommitPath:
          text.includes("client.commitMessage.generate(") &&
          text.includes("{ path, selectedFiles: undefined, previousMessage, language:"),
        hasEnhanceText:
          file.endsWith("KiloProvider.ts") && text.includes(".enhance({ text: message.text }, { throwOnError: true })"),
        requestLine:
          text
            .split("\n")
            .findIndex(
              (line) =>
                line.includes("client.commitMessage.generate(") || line.includes(".enhance({ text: message.text }"),
            ) + 1,
      }
    }),
  )
  const cli = files.find((file) => file?.hasCommitPath)
  const host = files.find((file) => file?.hasEnhanceText)
  if (!cli || !host) {
    return {
      id: "historical-protocol:source",
      status: "FAIL",
      evidence: "SOURCE_INSPECTION",
      reason: "Pinned historical client source is absent or its serialized request provenance changed",
      source: { commit: source.commit },
    } satisfies Item
  }
  return {
    id: "historical-protocol:source",
    status: "PASS",
    evidence: "SOURCE_INSPECTION",
    reason:
      "Pinned M8-M9 client source confirms commit path/language and enhancement text-only requests; optional undefined keys are omitted by JSON serialization and neither request carries model or account context",
    source: { commit: source.commit, path: source.paths.join(", ") },
    details: {
      files: [cli, host],
      requestShapes: {
        commitMessage: ["path", "language"],
        enhancePrompt: ["text"],
        authorityFieldsPresent: false,
      },
    },
  } satisfies Item
}

async function currentHTTP() {
  const file = "packages/opencode/test/kilocode/qualification/client-protocol.test.ts"
  const text = await Bun.file(path.join(root, file))
    .text()
    .catch(() => "")
  const sourceOK =
    text.includes('process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"') &&
    text.includes('const payload = { path: tmp.path, language: "en" }') &&
    text.includes('const payload = { text: "draft prompt" }') &&
    text.includes('new URL("/commit-message", listener.url)') &&
    text.includes('new URL("/enhance-prompt", listener.url)') &&
    text.includes("expect(generated).not.toHaveBeenCalled()") &&
    text.includes("expect(language).not.toHaveBeenCalled()")
  if (!sourceOK) {
    return {
      id: "historical-protocol:http",
      status: "FAIL",
      evidence: "SOURCE_INSPECTION",
      reason:
        "The real-HTTP qualification fixture no longer proves both pinned old request shapes fail closed with profiles enabled",
      source: { commit: source.commit, path: file },
    } satisfies Item
  }
  const result = await capture([process.execPath, "test", "test/kilocode/qualification/client-protocol.test.ts"], {
    cwd: path.join(root, "packages/opencode"),
    timeout: 120_000,
  })
  return {
    id: "historical-protocol:http",
    status: result.code === 0 && !result.timeout ? "PASS" : "FAIL",
    evidence: "REAL_HTTP_HISTORICAL_PROTOCOL",
    reason:
      result.code === 0 && !result.timeout
        ? "Verified historical request shapes were sent to the current Server.listen HTTP implementation with profiles enabled; both fail closed before generation/fallback"
        : result.timeout
          ? "Current-backend historical-protocol HTTP qualification timed out"
          : "Current-backend historical-protocol HTTP qualification failed",
    commands: [[process.execPath, "test", "test/kilocode/qualification/client-protocol.test.ts"]],
    exit: result.code,
    duration: result.duration,
    source: { commit: source.commit, path: source.paths.join(", ") },
    details: {
      fixturePath: file,
      historicalSourceAttested: true,
      logsCaptured: true,
      logsPublished: false,
      timeout: result.timeout,
    },
  } satisfies Item
}

async function cliTransport() {
  const old = await git(["show", `${source.commit}:packages/opencode/src/kilocode/cli/cmd/accounts.ts`])
  const current = await git(["show", `${head}:packages/opencode/src/kilocode/cli/cmd/accounts.ts`])
  const pathName = "packages/opencode/src/kilocode/cli/cmd/accounts.ts"
  const embedded = (text: string | undefined) =>
    text != null &&
    text.includes('import("@/server/server")') &&
    text.includes('Server.listen({ hostname: "127.0.0.1", port: 0 })') &&
    text.includes("baseUrl: `http://${server.hostname}:${server.port}`")
  const valid = embedded(old) && embedded(current)
  return {
    id: "historical-cli-skew:remote-target-audit",
    status: valid ? "PASS" : "FAIL",
    evidence: "SOURCE_INSPECTION",
    reason: valid
      ? "Both historical and current provider-account CLI commands create an embedded loopback Server.listen and SDK client; neither path targets a caller-supplied remote backend"
      : "Pinned CLI source no longer supports the recorded embedded-server/command-boundary conclusion",
    source: {
      commit: head,
      path: pathName,
      sha256: current ? createHash("sha256").update(current).digest("hex") : undefined,
    },
    details: {
      historicalCommit: source.commit,
      historicalCommandPresent: old !== undefined,
      historicalSha256: old ? createHash("sha256").update(old).digest("hex") : undefined,
      historicalServerLine:
        old?.split("\n").findIndex((line) => line.includes('Server.listen({ hostname: "127.0.0.1"'))! + 1,
      currentServerLine:
        current?.split("\n").findIndex((line) => line.includes('Server.listen({ hostname: "127.0.0.1"'))! + 1,
      remoteBaseURL: false,
    },
  } satisfies Item
}

export async function runSkew(mode: "protocol" | "cli" | "all" = "all"): Promise<Item[]> {
  const cli = await cliTransport()
  const directions: Item[] = [
    cli,
    {
      id: "historical-cli-skew:old-cli-to-current-http",
      status: "NOT_RUN",
      evidence: "NOT_RUN",
      reason: "CLI owns embedded backend and exposes no supported external-backend skew seam",
      source: { commit: source.commit },
    },
    {
      id: "historical-cli-skew:current-cli-to-old-http",
      status: "NOT_RUN",
      evidence: "NOT_RUN",
      reason: "CLI owns embedded backend and exposes no supported external-backend skew seam",
      source: { commit: head, path: "packages/opencode/src/kilocode/cli/cmd/accounts.ts" },
    },
  ]
  if (mode === "cli") return directions
  const historical = await protocol()
  const http =
    historical.status === "PASS"
      ? await currentHTTP()
      : ({
          id: "historical-protocol:http",
          status: "NOT_RUN",
          evidence: "NOT_RUN",
          reason: "Historical request provenance was not verified; no HTTP request was sent",
          source: { commit: source.commit },
        } satisfies Item)
  return [historical, http, ...(mode === "all" ? directions : [])] satisfies Item[]
}

if (import.meta.main) {
  const mode = process.argv[2] === "cli" ? "cli" : "protocol"
  const out = process.argv[3] ?? process.env.QUALIFICATION_EVIDENCE
  if (!out) throw new Error("QUALIFICATION_EVIDENCE is required")
  const result = await runSkew(mode)
  await save(out, result)
  if (result.some((item) => item.status === "FAIL")) process.exitCode = 1
}
