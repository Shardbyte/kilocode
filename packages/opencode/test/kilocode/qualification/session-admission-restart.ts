// Standalone fixture: each invocation is a fresh backend process against the same disk SQLite file.
import path from "node:path"
import fs from "node:fs/promises"

const db = process.env.SESSION_ADMISSION_DB
if (!db) throw new Error("SESSION_ADMISSION_DB is required")
const home = process.env.SESSION_ADMISSION_HOME
if (!home) throw new Error("SESSION_ADMISSION_HOME is required")
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_STATE_HOME = path.join(home, "state")
process.env.KILO_DB = db
process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
process.env.KILO_EXPERIMENTAL_EVENT_SYSTEM = "true"
process.env.KILO_EXPERIMENTAL_WORKSPACES = "true"
process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
process.env.KILO_MODELS_PATH = path.resolve("test/tool/fixtures/models-api.json")
const mode = process.argv[2]
const proj = path.join(home, "project")
await fs.mkdir(proj, { recursive: true })
const hits: Array<{ auth: string | null; account: string | null; body: string }> = []
const nativeFetch = globalThis.fetch
const mockFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== "chatgpt.com" && url.hostname !== "api.openai.com") return nativeFetch(input, init)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const body =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input
              .clone()
              .text()
              .catch(() => "")
          : ""
    hits.push({ auth: headers.get("authorization"), account: headers.get("chatgpt-account-id"), body })
    const text = "SESSION_ADMISSION_RESUME_OK"
    const item = {
      id: "msg_admission",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }
    const evts = [
      {
        type: "response.created",
        response: { id: "resp_admission", object: "response", status: "in_progress", model: "gpt-5-mini" },
      },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_admission",
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
      "[DONE]",
    ]
    return new Response(
      evts.map((evt) => `data: ${typeof evt === "string" ? evt : JSON.stringify(evt)}\n\n`).join(""),
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
  { preconnect: nativeFetch.preconnect },
)
await fs.writeFile(
  path.join(proj, "opencode.json"),
  JSON.stringify({
    model: "openai/gpt-5-mini",
    enabled_providers: ["openai"],
    provider: {
      openai: {
        id: "openai",
        name: "OpenAI session admission restart test",
        npm: "@ai-sdk/openai",
        options: {},
        models: {
          "gpt-5-mini": {
            id: "gpt-5-mini",
            name: "GPT-5 mini test",
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
      },
    },
  }),
)

const { Server } = await import("@/server/server")
const { ServerAuth } = await import("@/server/auth")
const { ProviderAccountProfiles } = await import("@opencode-ai/core/kilocode/provider-account-profiles")
const { AppRuntime } = await import("@/effect/app-runtime")
const { createKiloClient } = await import("@kilocode/sdk/v2")

globalThis.fetch = mockFetch
const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const sdk = createKiloClient({ baseUrl: `http://${server.hostname}:${server.port}`, headers: ServerAuth.headers() })
try {
  if (mode === "seed") {
    const created = await sdk.session.create({ directory: proj, title: "restart admission authority" })
    if (!created.data) throw new Error("session creation failed")
    const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
    const accounts = await Promise.all(
      ["A", "B"].map((name) =>
        AppRuntime.runPromise(
          profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: `restart-${name}`,
            remoteID: `restart-${name}`,
            credential: {
              access: `SESSION_ADMISSION_RESTART_ACCESS_${name}`,
              refresh: `SESSION_ADMISSION_RESTART_REFRESH_${name}`,
              expires: Date.now() + 60_000,
              accountID: `restart-${name}`,
            },
          }),
        ),
      ),
    )
    await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))
    const assigned = await sdk.providerAccounts.session.assign({
      sessionID: created.data.id,
      providerID: "openai",
      accountID: accounts[0]!.id,
      directory: proj,
    })
    if (!assigned.data) throw new Error("binding assignment failed")
    const first = await sdk.session.prompt({
      sessionID: created.data.id,
      directory: proj,
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      parts: [{ type: "text", text: "SESSION_ADMISSION_BEFORE_RESTART" }],
    })
    if (!first.data || first.data.info.error) throw new Error(`initial prompt failed: ${JSON.stringify(first.data)}`)
    console.log(
      JSON.stringify({
        sessionID: created.data.id,
        accountID: accounts[0]!.id,
        otherID: accounts[1]!.id,
        authA: hits[0]?.auth === "Bearer SESSION_ADMISSION_RESTART_ACCESS_A",
      }),
    )
  } else if (mode === "replay") {
    const ids = JSON.parse(process.env.SESSION_ADMISSION_IDS ?? "{}") as {
      sessionID: string
      accountID: string
      otherID: string
    }
    const before = await sdk.providerAccounts.session.get({
      sessionID: ids.sessionID,
      providerID: "openai",
      directory: proj,
    })
    const forged = await sdk.session.update({
      sessionID: ids.sessionID,
      directory: proj,
      metadata: {
        kilocode: {
          providerBindings: {
            version: 1,
            providers: {
              openai: { mode: "profile", profileID: ids.otherID, authMode: "chatgpt-oauth", source: "explicit" },
            },
          },
          replayProbe: "restarted-process",
        },
      },
    })
    const attempted = await sdk.providerAccounts.session.assign({
      sessionID: ids.sessionID,
      providerID: "openai",
      accountID: ids.otherID,
      directory: proj,
    })
    const after = await sdk.providerAccounts.session.get({
      sessionID: ids.sessionID,
      providerID: "openai",
      directory: proj,
    })
    const resumed = await sdk.session.prompt({
      sessionID: ids.sessionID,
      directory: proj,
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      parts: [{ type: "text", text: "SESSION_ADMISSION_AFTER_RESTART" }],
    })
    console.log(
      JSON.stringify({
        before: before.data,
        forged: forged.data,
        assignmentStatus: attempted.response?.status,
        assignmentError: attempted.error,
        after: after.data,
        resumed: resumed.data,
        authA: hits[0]?.auth === "Bearer SESSION_ADMISSION_RESTART_ACCESS_A",
        account: hits[0]?.account,
        body: hits[0]?.body,
      }),
    )
  } else {
    throw new Error(`unknown session-admission fixture mode: ${mode}`)
  }
} finally {
  await server.stop(true)
}
process.exit(0)
