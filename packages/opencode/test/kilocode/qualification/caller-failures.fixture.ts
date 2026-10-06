import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "kilocode-caller-failures-"))
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_STATE_HOME = path.join(home, "state")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.KILO_DB = path.join(home, "store.sqlite")
process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
process.env.KILO_PRINT_LOGS = "1"
process.env.KILO_LOG_LEVEL = "DEBUG"
process.env.KILO_MODELS_PATH = path.resolve("test/tool/fixtures/models-api.json")
process.env.OPENAI_API_KEY = "SECRET_ENV_KEY"
process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "SECRET_LEGACY_KEY" } })

const [
  { AppRuntime },
  { ProviderAccountProfiles },
  { ModelV2 },
  { ProviderV2 },
  { handle },
  { ProviderTest },
  { tmpdir },
] = await Promise.all([
  import("@/effect/app-runtime"),
  import("@opencode-ai/core/kilocode/provider-account-profiles"),
  import("@opencode-ai/core/model"),
  import("@opencode-ai/core/provider"),
  import("@/kilocode/cli/cmd/roll-call"),
  import("../../fake/provider"),
  import("../../fixture/fixture"),
])
const { Agent } = await import("@/agent/agent")
const { UtilityAccount } = await import("@/kilocode/provider/utility-account")
const { provide: provideInstance } = await import("@/kilocode/instance")
const { KiloLog } = await import("@/kilocode/log")
const { Effect, Cause } = await import("effect")
const { Log } = await import("@opencode-ai/core/util/log")
let appRuntimeRuns = 0
let apiFailures = 0
const runtime = AppRuntime as unknown as {
  runPromise: (effect: never, options?: never) => Promise<unknown>
}
const originalRun = runtime.runPromise
Reflect.set(runtime, "runPromise", (effect: never, options?: never) => {
  appRuntimeRuns++
  return originalRun.call(AppRuntime, effect, options)
})

await KiloLog.init()
Log.create({ service: "caller-failures-qualification" }).info("CALLER_FAILURE_LOG_CONTROL")

const model = ProviderTest.model({
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-5-mini", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
})
const modelRef = { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5-mini") }
const origins = [
  {
    name: "quota-429",
    status: 429,
    body: { error: { message: "SECRET_PROVIDER_ERROR SECRET_ACCESS_A", code: "FreeUsageLimitError" } },
  },
  {
    name: "service-503",
    status: 503,
    body: { error: { message: "SECRET_PROVIDER_ERROR SECRET_ENV_KEY", code: "FreeUsageLimitError" } },
  },
  { name: "malformed-400", status: 400, raw: "{ SECRET_PROVIDER_ERROR SECRET_ACCESS_A" },
  {
    name: "timeout",
    reject: () => {
      throw new DOMException("request timed out SECRET_ACCESS_A", "TimeoutError")
    },
  },
  {
    name: "dns-nested-cause",
    reject: () => {
      throw new Error("fetch failed SECRET_PROVIDER_ERROR", {
        cause: new Error("getaddrinfo ENOTFOUND api.example SECRET_ACCESS_A"),
      })
    },
  },
  { name: "malformed-refresh", refresh: true, raw: "not-json SECRET_REFRESH_A SECRET_PROVIDER_ERROR" },
] as const

const priorFetch = globalThis.fetch
const cases: Array<{ caller: string; origin: string; requests: number; result: string }> = []
const profileIDs: string[] = []
const markers = [
  "SECRET_ACCESS_A",
  "SECRET_REFRESH_A",
  "SECRET_PROVIDER_ERROR",
  "SECRET_ENV_KEY",
  "SECRET_LEGACY_KEY",
  "SECRET_ACCOUNT_B",
  "SECRET_ACCOUNT_B_REFRESH",
]

await using tmp = await tmpdir({
  git: true,
  config: {
    formatter: false,
    lsp: false,
    enabled_providers: ["openai"],
    provider: {
      openai: {
        id: "openai",
        name: "OpenAI caller failure qualification",
        npm: "@ai-sdk/openai",
        env: ["OPENAI_API_KEY"],
        models: {
          "gpt-5-mini": {
            id: "gpt-5-mini",
            name: "GPT-5 mini qualification",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {},
      },
    },
  },
})

try {
  await provideInstance({
    directory: tmp.path,
    fn: async () => {
      const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
      const a = await AppRuntime.runPromise(
        profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "failure A",
          remoteID: "failure-A",
          credential: {
            access: "SECRET_ACCESS_A",
            refresh: "ROTATING_REFRESH_A",
            expires: Date.now() + 60_000,
            accountID: "failure-A",
          },
        }),
      )
      profileIDs.push(a.id)
      const b = await AppRuntime.runPromise(
        profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "failure B default",
          remoteID: "failure-B",
          credential: {
            access: "SECRET_ACCOUNT_B",
            refresh: "SECRET_ACCOUNT_B_REFRESH",
            expires: Date.now() + 60_000,
            accountID: "failure-B",
          },
        }),
      )
      profileIDs.push(b.id)
      await AppRuntime.runPromise(profiles.selectDefault("openai", "chatgpt-oauth", b.id))
      const context = {
        kind: "account" as const,
        providerID: "openai" as const,
        authMode: "chatgpt-oauth" as const,
        accountID: a.id,
      }
      const agent = await AppRuntime.runPromise(Agent.Service)
      const calls: Array<{ url: string; headers: Headers; body: string }> = []
      let current: (typeof origins)[number] = origins[0]!
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : undefined
          const url = req?.url ?? (input instanceof URL ? input.href : String(input))
          const parsed = new URL(url)
          const headers = new Headers(req?.headers)
          if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
          const body =
            typeof init?.body === "string"
              ? init.body
              : req
                ? await req
                    .clone()
                    .text()
                    .catch(() => "")
                : ""
          if (["api.openai.com", "chatgpt.com", "auth.openai.com"].includes(parsed.hostname))
            calls.push({ url, headers, body })
          if (parsed.hostname === "auth.openai.com" && "refresh" in current)
            return new Response(current.raw, { status: 200 })
          if ("reject" in current) return current.reject()
          if ("raw" in current && !("status" in current))
            throw new Error("unexpected transport after refresh parser failure")
          if (!("status" in current)) throw new Error("unexpected provider response shape")
          if (parsed.hostname === "api.openai.com" || parsed.hostname === "chatgpt.com") apiFailures++
          return "raw" in current
            ? new Response(current.raw, { status: current.status, headers: { "retry-after": "0" } })
            : Response.json(current.body, { status: current.status, headers: { "retry-after": "0" } })
        },
        { preconnect: priorFetch.preconnect },
      )

      for (const origin of origins) {
        current = origin
        const credential = await AppRuntime.runPromise(profiles.credential(a.id))
        if (!credential) throw new Error("profile A credential missing")
        await AppRuntime.runPromise(
          profiles.compareAndSwapCredential({
            id: a.id,
            revision: credential.revision,
            value: { ...credential.value, expires: "refresh" in origin ? 0 : Date.now() + 60_000 },
          }),
        )

        const agentStart = calls.length
        const exit = await AppRuntime.runPromise(
          agent
            .generate({ description: `generation ${origin.name}`, model: modelRef, utilityContext: context })
            .pipe(Effect.exit),
        )
        if (exit._tag !== "Failure") throw new Error(`Agent.generate unexpectedly succeeded for ${origin.name}`)
        const failure = Cause.squash(exit.cause)
        if (!(failure instanceof UtilityAccount.Failure))
          throw new Error(`Agent.generate escaped UtilityAccountFailure for ${origin.name}`)
        const agentCalls = calls.slice(agentStart)
        verifyCalls(agentCalls, origin.name, "agent.generate")
        cases.push({ caller: "Agent.generate", origin: origin.name, requests: agentCalls.length, result: failure.code })
        process.stdout.write(`CALLER_FAILURE_RESULT ${JSON.stringify(cases.at(-1))}\n`)

        const cred = await AppRuntime.runPromise(profiles.credential(a.id))
        if (!cred) throw new Error("profile A credential missing before roll-call")
        if ("refresh" in origin)
          await AppRuntime.runPromise(
            profiles.compareAndSwapCredential({
              id: a.id,
              revision: cred.revision,
              value: { ...cred.value, expires: 0 },
            }),
          )
        const rollStart = calls.length
        const consoleLog = console.log
        const cwd = process.cwd()
        process.chdir(tmp.path)
        console.log = (...args: unknown[]) => {
          const rows: unknown = JSON.parse(args.map(String).join(" "))
          if (!Array.isArray(rows) || rows.length !== 1) throw new Error("roll-call did not return one failure row")
          const row = rows.at(0) as { access?: unknown; errorMessage?: unknown }
          if (
            row.access !== false ||
            !["The operation timed out.", "The model request failed."].includes(String(row.errorMessage))
          )
            throw new Error("roll-call did not surface a static failed request")
          process.stdout.write(`ROLL_CALL_STDOUT ${args.map(String).join(" ")}\n`)
        }
        try {
          await handle({
            prompt: "Confirm model connectivity",
            timeout: 10_000,
            filter: "openai/gpt-5-mini",
            parallel: 1,
            output: "json",
            verbose: false,
            quiet: true,
            legacyAuth: false,
            account: a.id,
            list: async () => ({
              openai: { id: ProviderV2.ID.openai, name: "OpenAI", models: { "gpt-5-mini": model } },
            }),
          } as never)
        } finally {
          console.log = consoleLog
          process.chdir(cwd)
        }
        const rollCalls = calls.slice(rollStart)
        verifyCalls(rollCalls, origin.name, "roll-call")
        cases.push({ caller: "roll-call", origin: origin.name, requests: rollCalls.length, result: "closed" })
        process.stdout.write(`CALLER_FAILURE_RESULT ${JSON.stringify(cases.at(-1))}\n`)
      }

      function verifyCalls(reqs: Array<{ url: string; headers: Headers; body: string }>, name: string, caller: string) {
        if (reqs.length < 1 || reqs.length > 4)
          throw new Error(`${caller} request bound failed for ${name}: ${reqs.length}`)
        const refresh = name === "malformed-refresh"
        if (
          !reqs.every((item) =>
            refresh
              ? item.url === "https://auth.openai.com/oauth/token"
              : (item.url.startsWith("https://chatgpt.com/") || item.url.startsWith("https://api.openai.com/")) &&
                item.headers.get("authorization") === "Bearer SECRET_ACCESS_A" &&
                item.headers.get("chatgpt-account-id") === "failure-A",
          )
        )
          throw new Error(`${caller} transport identity failed for ${name}`)
        const body = JSON.stringify(reqs.map((item) => item.body))
        for (const marker of markers)
          if (body.includes(marker)) throw new Error(`${caller} outbound body contained marker ${marker}`)
        const headers = JSON.stringify(reqs.map((item) => Object.fromEntries(item.headers)))
        for (const marker of markers.slice(1))
          if (headers.includes(marker)) throw new Error(`${caller} outbound header contained a non-selected secret`)
      }
    },
  })
  const log = JSON.stringify(cases)
  if (cases.length !== origins.length * 2) throw new Error(`incomplete caller failure matrix: ${cases.length}`)
  if (markers.some((marker) => log.includes(marker))) throw new Error("case summary leaked sensitive input")
} finally {
  globalThis.fetch = priorFetch
  for (const id of profileIDs) {
    await AppRuntime.runPromise(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(id))).catch(() => {
      process.stderr.write("CALLER_FAILURE_PROFILE_CLEANUP_FAILED\n")
    })
  }
  Reflect.set(runtime, "runPromise", originalRun)
  await fs.rm(home, { recursive: true, force: true })
}
process.stdout.write(
  `CALLER_FAILURE_MATRIX ${JSON.stringify({
    cases,
    apiFailures,
    apiAttempts: cases.reduce((count, item) => count + item.requests, 0),
    logControls: 1,
    agentFailureRows: cases.filter((item) => item.caller === "Agent.generate").length,
    rollCallFailureRows: cases.filter((item) => item.caller === "roll-call").length,
    appRuntimeRuns,
  })}\n`,
)
await AppRuntime.dispose()
process.exit(0)
