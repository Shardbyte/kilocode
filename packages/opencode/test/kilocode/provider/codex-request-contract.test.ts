import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createOpenAI } from "@ai-sdk/openai"
import { jsonSchema, streamText, tool, wrapLanguageModel, type ModelMessage } from "ai"
import type { PluginInput } from "@kilocode/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import type { Plugin } from "@/plugin"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { makeFetch } from "@/kilocode/provider/codex-profile"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderTransform } from "@/provider/transform"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { KiloSessionProcessor } from "@/kilocode/session/processor"

const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-5.4"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-5.4", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5.4",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 400_000, output: 128_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-03-01",
}

test.each([
  { name: "build", replay: false },
  { name: "build", replay: true },
  { name: "title", replay: false },
  { name: "branch-name", replay: true },
])("preserves legacy/profile Codex wire parity for %s", async (scenario) => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> }> = []
  const request: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: await req.json() })
      return Response.json(
        { error: { type: "invalid_request_error", code: "invalid_request", message: "SYNTHETIC_PRIVATE_ERROR" } },
        { status: 400 },
      )
    },
    { preconnect: original.preconnect },
  )
  globalThis.fetch = request
  const auth = {
    type: "oauth" as const,
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: Date.now() + 60_000,
    accountId: "fixture-account",
  }
  try {
    const hooks = await CodexAuthPlugin({} as PluginInput)
    const loaded = await hooks.auth!.loader!(async () => auth, {} as never)
    const plugin: Plugin.Interface = {
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (name, input, output) =>
        Effect.promise(async () => {
          if (name === "chat.headers") await hooks["chat.headers"]!(input as never, output as never)
          if (name === "chat.params") await hooks["chat.params"]!(input as never, output as never)
          return output
        }),
    }
    const flags = await Effect.runPromise(
      RuntimeFlags.Service.pipe(Effect.provide(RuntimeFlags.layer({ client: "test" }))),
    )
    const dispatch: string[] = []
    const profile = makeFetch("fixture-profile", {
      refresh: async (id) => {
        expect(id).toBe("fixture-profile")
      },
      dispatch: async (id, transport) => {
        dispatch.push(id)
        return {
          response: transport(
            { access: auth.access, refresh: auth.refresh, expires: auth.expires, accountID: auth.accountId },
            0,
          ),
        }
      },
      request,
    })
    for (const mode of ["legacy", "profile", "api"]) {
      const prepared = await Effect.runPromise(
        LLMRequestPrep.prepare({
          user: {
            id: MessageID.make("msg_fixture"),
            sessionID: SessionID.make("ses_fixture"),
            role: "user",
            time: { created: 0 },
            agent: scenario.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          sessionID: "ses_fixture",
          model,
          agent: { name: scenario.name, mode: "primary", options: {}, permission: [], prompt: "Fixture instruction" },
          system: [],
          messages: scenario.replay
            ? ([
                { role: "user", content: "Fixture input" },
                {
                  role: "assistant",
                  content: [
                    {
                      type: "reasoning",
                      text: "Fixture reasoning",
                      providerOptions: {
                        openai: { itemId: "rs_fixture", reasoningEncryptedContent: "fixture_encrypted" },
                      },
                    },
                    { type: "tool-call", toolCallId: "call_fixture", toolName: "lookup", input: { query: "fixture" } },
                  ],
                },
                {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: "call_fixture",
                      toolName: "lookup",
                      output: { type: "text", value: "Fixture result" },
                    },
                  ],
                },
                { role: "user", content: "Fixture follow-up" },
              ] satisfies ModelMessage[])
            : [{ role: "user", content: "Fixture input" }],
          tools: {
            lookup: tool({
              description: "Fixture lookup",
              inputSchema: jsonSchema({
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              }),
            }),
          },
          provider: { id: model.providerID, name: "OpenAI", source: "custom", env: [], options: {}, models: {} },
          // LLM.run deliberately supplies no legacy auth for profile-bound requests.
          auth: mode === "legacy" ? auth : mode === "api" ? { type: "api", key: "fixture-api" } : undefined,
          oauth: mode === "profile",
          plugin,
          flags,
          isWorkflow: false,
        }),
      )
      const sdk = createOpenAI({
        apiKey: mode === "api" ? "fixture-api" : "fixture-dummy",
        fetch: mode === "legacy" ? loaded.fetch : mode === "profile" ? profile : request,
      })
      const result = streamText({
        model: wrapLanguageModel({
          model: sdk.responses(model.api.id),
          middleware: {
            specificationVersion: "v3",
            transformParams: async ({ params }) => ({
              ...params,
              prompt: ProviderTransform.message(
                params.prompt,
                model,
                prepared.messageTransformOptions,
              ) as typeof params.prompt,
            }),
          },
        }),
        messages: prepared.messages,
        tools: prepared.tools,
        headers: prepared.headers,
        providerOptions: ProviderTransform.providerOptions(model, prepared.params.options),
        maxOutputTokens: prepared.params.maxOutputTokens,
        maxRetries: 0,
        allowSystemInMessages: true,
        onError: () => undefined,
      })
      const errors: unknown[] = []
      for await (const event of result.fullStream) {
        if (event.type !== "error") continue
        errors.push(event.error)
        const safe = KiloSessionProcessor.profileError(
          MessageV2.fromError(event.error, { providerID: model.providerID }),
        )
        expect(safe).toMatchObject({
          name: "APIError",
          data: { message: "The selected provider account request failed.", statusCode: 400, isRetryable: false },
        })
        expect(JSON.stringify(safe)).not.toContain("SYNTHETIC_PRIVATE_ERROR")
        expect(JSON.stringify(safe)).not.toContain("fixture-access")
      }
      expect(errors).toHaveLength(1)
    }
    expect(calls).toHaveLength(3)
    expect(dispatch).toEqual(["fixture-profile"])
    for (const call of calls.slice(0, 2)) {
      expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(call.method).toBe("POST")
      expect(call.headers.get("authorization")).toBe("Bearer fixture-access")
      expect(call.headers.get("chatgpt-account-id")).toBe("fixture-account")
      expect(call.headers.has("originator")).toBe(true)
      expect(call.headers.has("session-id")).toBe(true)
      expect(call.headers.has("user-agent")).toBe(true)
      expect(call.headers.get("content-type")).toContain("application/json")
      expect(call.body).toMatchObject({ model: "gpt-5.4", stream: true, store: false })
      expect(call.body.max_output_tokens).toBeUndefined()
    }
    const api = calls.at(2)!
    expect(api.url).toBe("https://api.openai.com/v1/responses")
    expect(api.headers.get("authorization")).toBe("Bearer fixture-api")
    expect(api.headers.has("chatgpt-account-id")).toBe(false)
    expect(api.body.instructions).toBeUndefined()
    const messages = api.body.input as Array<{ role?: string; content?: unknown }>
    expect(messages.at(0)).toEqual({ role: "developer", content: calls.at(0)!.body.instructions })
    expect(calls.at(0)!.body.input).toEqual(messages.slice(1))
    const legacy = calls.at(0)!.body
    const bound = calls.at(1)!.body
    expect(typeof legacy.instructions).toBe("string")
    expect(bound.instructions).toBe(legacy.instructions)
    expect(bound).toEqual(legacy)
    const input = bound.input as Array<{ role?: string; type?: string; encrypted_content?: string }>
    expect(input.some((item) => item.role === "system" || item.role === "developer")).toBe(false)
    expect(input.at(0)).toMatchObject({ role: "user" })
    expect(bound.tools).toMatchObject([{ type: "function", name: "lookup", strict: false }])
    expect(bound.reasoning).toMatchObject({ effort: "medium" })
    if (scenario.replay) {
      expect(input).toContainEqual(
        expect.objectContaining({ type: "reasoning", encrypted_content: "fixture_encrypted" }),
      )
      expect(input).toContainEqual(expect.objectContaining({ type: "function_call" }))
      expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output" }))
    }
    expect([...calls.at(0)!.headers]).toEqual([...calls.at(1)!.headers])
  } finally {
    globalThis.fetch = original
  }
})

test("characterizes OAuth model filtering being skipped when only profile credentials exist", async () => {
  const hooks = await CodexAuthPlugin({} as PluginInput)
  const models = Object.fromEntries(
    ["gpt-5.4", "gpt-4.1", "gpt-5.6", "gpt-5.5-pro"].map((id) => [
      id,
      { ...model, id: ModelV2.ID.make(id), api: { ...model.api, id } },
    ]),
  )
  const provider = { id: "openai", models } as never
  const legacy = await hooks.provider!.models!(provider, {
    auth: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 },
  })
  const profile = await hooks.provider!.models!(provider, { auth: undefined })
  expect(Object.keys(legacy)).toEqual(["gpt-5.4"])
  expect(Object.keys(profile)).toEqual(Object.keys(models))
})

test("profile fetch preserves inherited body options rather than normalizing Codex compatibility", async () => {
  const body = JSON.stringify({
    model: "gpt-5.4",
    stream: true,
    store: true,
    temperature: 0.5,
    max_output_tokens: 42,
    instructions: "Fixture instruction",
    input: [],
  })
  const calls: string[] = []
  const send = makeFetch("fixture-profile", {
    refresh: async () => undefined,
    dispatch: async (id, transport) => {
      expect(id).toBe("fixture-profile")
      return {
        response: transport(
          { access: "fixture-access", refresh: "fixture-refresh", expires: 1, accountID: "fixture-account" },
          0,
        ),
      }
    },
    request: async (input, init) => {
      expect(input).toEqual(new URL("https://chatgpt.com/backend-api/codex/responses"))
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer fixture-access")
      expect(headers.get("chatgpt-account-id")).toBe("fixture-account")
      expect(headers.has("x-openai-internal-codex-residency")).toBe(false)
      expect(headers.has("x-kilo-title")).toBe(false)
      expect(init?.redirect).toBe("error")
      if (typeof init?.body !== "string") throw new Error("Expected the SDK JSON body")
      calls.push(init.body)
      return new Response(null, { status: 400 })
    },
  })
  expect(
    (
      await send("https://api.openai.com/v1/responses", {
        method: "POST",
        body,
        headers: {
          authorization: "Bearer legacy-fixture",
          "chatgpt-account-id": "legacy-fixture",
          "x-openai-internal-codex-residency": "legacy-fixture",
          "x-kilo-title": "true",
        },
      })
    ).status,
  ).toBe(400)
  expect(calls).toEqual([body])
})
