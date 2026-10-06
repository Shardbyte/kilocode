import path from "node:path"
import { mkdir } from "node:fs/promises"
import { responses } from "./title-caller.fixture"

const [root, home, mode = "reauth"] = process.argv.slice(2)
if (!root || !home) throw new Error("Lifecycle SDK paths are required")
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_STATE_HOME = path.join(home, "state")
process.env.KILO_DB = path.join(root, "lifecycle-sdk.sqlite")
process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
process.env.KILO_EXPERIMENTAL_EVENT_SYSTEM = "true"
process.env.KILO_EXPERIMENTAL_WORKSPACES = "true"
process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
process.env.KILO_MODELS_PATH = path.resolve("test/tool/fixtures/models-api.json")
process.env.KILO_CONFIG_CONTENT = JSON.stringify({
  model: "openai/gpt-5",
  small_model: "openai/gpt-5",
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      options: {},
      models: { "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } } },
    },
  },
})
process.env.OPENAI_API_KEY = "LIFECYCLE_SDK_ENV_POISON"
process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "LIFECYCLE_SDK_LEGACY_POISON" } })
const dir = path.join(root, "project")
await mkdir(dir, { recursive: true })
await Bun.write(
  path.join(dir, "opencode.json"),
  JSON.stringify({
    model: "openai/gpt-5",
    small_model: "openai/gpt-5",
    provider: {
      openai: {
        id: "openai",
        name: "OpenAI test",
        npm: "@ai-sdk/openai",
        env: ["OPENAI_API_KEY"],
        options: {},
        models: {
          "gpt-5": {
            id: "gpt-5",
            name: "GPT-5 test",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 128000, output: 4096 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
      },
    },
    formatter: false,
    lsp: false,
  }),
)

const nativeFetch = globalThis.fetch
const arrived = Promise.withResolvers<void>()
const dispatched = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const calls: Array<{ bearer: string | null; account: string | null; url: string }> = []
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (
      !url.startsWith("https://chatgpt.com/backend-api/codex/responses") &&
      !url.startsWith("https://api.openai.com/v1/")
    ) {
      if (new URL(url).hostname === "127.0.0.1" || new URL(url).hostname === "localhost")
        return nativeFetch(input, init)
      return Response.json({})
    }
    const headers = new Headers(
      init?.headers ?? (typeof input === "string" || input instanceof URL ? undefined : input.headers),
    )
    const count = calls.push({ url, bearer: headers.get("authorization"), account: headers.get("chatgpt-account-id") })
    if (count === 4) dispatched.resolve()
    if (count === 2) {
      console.log(`LIFECYCLE_SDK ${JSON.stringify({ event: "handoff", calls })}`)
      arrived.resolve()
    }
    if (count <= 2) await release.promise
    if (headers.get("chatgpt-account-id") !== "lifecycle-sdk-B") return responses("synthetic answer")
    return Response.json({
      id: `resp_lifecycle_${count}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: "gpt-5",
      output: [
        {
          id: `msg_${count}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "synthetic answer", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  },
  { preconnect: nativeFetch.preconnect },
)

const { Server } = await import("@/server/server")
const { ServerAuth } = await import("@/server/auth")
const { ProviderAccountProfiles } = await import("@opencode-ai/core/kilocode/provider-account-profiles")
const { AppRuntime } = await import("@/effect/app-runtime")
const { createKiloClient } = await import("@kilocode/sdk/v2")
const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const sdk = createKiloClient({
  baseUrl: `http://${server.hostname}:${server.port}`,
  headers: ServerAuth.headers(),
  fetch: nativeFetch,
})
try {
  const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
  const a = await AppRuntime.runPromise(
    profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "sdk-A",
      remoteID: "lifecycle-sdk-A",
      credential: {
        access: "LIFECYCLE_SDK_A_OLD",
        refresh: "LIFECYCLE_SDK_A_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "lifecycle-sdk-A",
      },
    }),
  )
  const b = await AppRuntime.runPromise(
    profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "sdk-B",
      remoteID: "lifecycle-sdk-B",
      credential: {
        access: "LIFECYCLE_SDK_B",
        refresh: "LIFECYCLE_SDK_B_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "lifecycle-sdk-B",
      },
    }),
  )
  await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))
  const session = await sdk.session.create({ directory: dir, title: "SDK lifecycle" })
  if (!session.data) throw new Error("session creation failed")
  const assigned = await sdk.providerAccounts.session.assign({
    sessionID: session.data.id,
    providerID: "openai",
    accountID: a.id,
    directory: dir,
  })
  if (!assigned.data) throw new Error(`session binding failed: ${JSON.stringify(assigned.error)}`)
  const input = { providerID: "openai", modelID: "gpt-5" }
  const pending = Promise.all([
    sdk.session.prompt({
      sessionID: session.data.id,
      directory: dir,
      agent: "build",
      model: input,
      parts: [{ type: "text", text: "Synthetic lifecycle request A." }],
    }),
    sdk.enhancePrompt.enhance({
      directory: dir,
      text: "Synthetic lifecycle request B.",
      model: input,
      accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
    }),
  ])
  await Promise.race([
    arrived.promise,
    pending.then(
      () => new Promise<never>(() => {}),
      (error) =>
        Promise.reject(
          new Error(`SDK callers settled before HTTP handoff: ${error instanceof Error ? error.stack : String(error)}`),
        ),
    ),
  ])
  if (mode === "delete") {
    await AppRuntime.runPromise(profiles.remove(a.id))
  } else {
    await AppRuntime.runPromise(profiles.selectDefault("openai", "chatgpt-oauth", b.id))
    await AppRuntime.runPromise(
      profiles.reauthenticate({
        id: a.id,
        revision: 0,
        remoteID: "lifecycle-sdk-A",
        value: {
          access: "LIFECYCLE_SDK_A_NEW",
          refresh: "LIFECYCLE_SDK_A_NEW_REFRESH",
          expires: Date.now() + 60_000,
          accountID: "lifecycle-sdk-A",
        },
      }),
    )
  }
  console.log("LIFECYCLE_SDK_READY")
  const reader = Bun.stdin.stream().getReader()
  const line = await reader.read()
  if (!line.value || new TextDecoder().decode(line.value).trim() !== "release")
    throw new Error("lifecycle release signal required")
  release.resolve()
  if (mode === "delete") {
    const completed = await pending
    const outcomes = await Promise.allSettled([
      sdk.session.prompt({
        sessionID: session.data.id,
        directory: dir,
        agent: "build",
        model: input,
        parts: [{ type: "text", text: "Synthetic lifecycle request A2." }],
      }),
      sdk.enhancePrompt.enhance({
        directory: dir,
        text: "Synthetic lifecycle request B2.",
        model: input,
        accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
      }),
    ])
    console.log(
      `LIFECYCLE_SDK ${JSON.stringify({
        event: "result",
        mode,
        calls,
        completed: completed.map((item) => item.response?.status),
        errors: completed.map((item) => item.error),
        retries: outcomes.map((item) => (item.status === "fulfilled" ? item.value.response?.status : "rejected")),
      })}`,
    )
  } else {
    const result = await pending
    const retry = await Promise.all([
      sdk.session.prompt({
        sessionID: session.data.id,
        directory: dir,
        agent: "build",
        model: input,
        parts: [{ type: "text", text: "Synthetic lifecycle request A2." }],
      }),
      sdk.enhancePrompt.enhance({
        directory: dir,
        text: "Synthetic lifecycle request B2.",
        model: input,
        accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
      }),
    ])
    console.log(
      `LIFECYCLE_SDK ${JSON.stringify({ event: "result", mode, calls, statuses: [...result, ...retry].map((item) => item.response?.status) })}`,
    )
  }
} finally {
  release.resolve()
  globalThis.fetch = nativeFetch
  await server.stop(true)
  await AppRuntime.dispose()
}
process.exit(0)
