import { expect, spyOn } from "bun:test"
import { TestInstance } from "../../fixture/fixture"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@/provider/models"
import { handle } from "@/kilocode/cli/cmd/roll-call"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"
import { ProviderTest } from "../../fake/provider"
import { provide as runInstance } from "@/kilocode/instance"
import { InstanceStore } from "@/project/instance-store"

const config = {
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      models: { "gpt-roll-call": { name: "Roll Call", limit: { context: 128000, output: 4096 } } },
    },
  },
}

const layer = AppNodeBuilder.build(
  LayerNode.group([Provider.node, ProviderAccountProfiles.node, RuntimeFlags.node, ModelsDev.node, Config.node]),
  [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed(config) })],
    [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
  ],
)

const it = testEffect(layer)

it.instance("roll-call qualifies explicit account A through real SDK transport and fails closed", () =>
  Effect.gen(function* () {
    const dir = yield* TestInstance
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = {
          cwd: process.cwd(),
          flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
          native: process.env.KILO_EXPERIMENTAL_NATIVE_LLM,
          key: process.env.OPENAI_API_KEY,
          auth: process.env.KILO_AUTH_CONTENT,
          fetch: globalThis.fetch,
        }
        process.chdir(dir.directory)
        const calls: Array<{ url: string; headers: Headers; body: string }> = []
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.KILO_EXPERIMENTAL_NATIVE_LLM = "1"
        process.env.OPENAI_API_KEY = "ROLL_CALL_ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "ROLL_CALL_LEGACY_POISON" } })
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input.toString()
            const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
            const method = init?.method ?? (input instanceof Request ? input.method : "GET")
            if (method === "POST" || headers.has("authorization") || headers.has("x-api-key"))
              calls.push({
                url,
                headers,
                body:
                  typeof init?.body === "string"
                    ? init.body
                    : input instanceof Request
                      ? await input.clone().text()
                      : "",
              })
            return Response.json({
              id: "resp_roll_call",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "gpt-roll-call",
              output: [
                {
                  id: "msg_roll_call",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "synthetic SDK response", annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            })
          },
          { preconnect: prior.fetch.preconnect },
        )
        return { ...prior, calls }
      }),
      (state) =>
        Effect.gen(function* () {
          const item = ProviderTest.model({
            id: ModelV2.ID.make("gpt-roll-call"),
            providerID: ProviderV2.ID.openai,
            api: { id: "gpt-roll-call", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
          })
          const info = ProviderTest.info({}, item)
          const make = (label: string, access: string, refresh: string, remoteID: string) =>
            Effect.promise(async () =>
              runInstance({
                directory: dir.directory,
                fn: () =>
                  AppRuntime.runPromise(
                    ProviderAccountProfiles.Service.use((profiles) =>
                      profiles.create({
                        provider: "openai",
                        authMode: "chatgpt-oauth",
                        label,
                        remoteID,
                        credential: { access, refresh, expires: Date.now() + 60_000, accountID: remoteID },
                      }),
                    ),
                  ),
              }),
            )
          const a = yield* make("A", "ROLL_CALL_A_ACCESS", "ROLL_CALL_A_REFRESH", "roll-call-A")
          const b = yield* make("B default", "ROLL_CALL_B_ACCESS", "ROLL_CALL_B_REFRESH", "roll-call-B")
          yield* Effect.promise(() =>
            runInstance({
              directory: dir.directory,
              fn: () =>
                AppRuntime.runPromise(
                  ProviderAccountProfiles.Service.use((profiles) =>
                    profiles.selectDefault("openai", "chatgpt-oauth", b.id),
                  ),
                ),
            }),
          )

          const log = spyOn(console, "log").mockImplementation(() => {})
          const args = {
            filter: "openai/gpt-roll-call(?:-config-poison)?",
            prompt: "synthetic roll-call prompt",
            timeout: 5000,
            parallel: 1,
            output: "json" as const,
            verbose: false,
            quiet: true,
            account: a.id,
            legacyAuth: false,
          }
          try {
            yield* Effect.promise(async () =>
              handle({
                ...args,
                list: async () => ({ openai: { ...info, models: { "gpt-roll-call": item } } }),
              }),
            )
            expect(state.calls).toHaveLength(1)
            expect(state.calls.at(0)?.url).toStartWith("https://chatgpt.com/backend-api/codex/responses")
            expect(state.calls.at(0)?.headers.get("authorization")).toBe("Bearer ROLL_CALL_A_ACCESS")
            expect(state.calls.at(0)?.headers.get("chatgpt-account-id")).toBe("roll-call-A")
            const wire = JSON.stringify(
              state.calls.map((call) => ({ ...call, headers: Object.fromEntries(call.headers) })),
            )
            expect(wire).not.toContain("POISON")
            expect(wire).not.toContain("ROLL_CALL_B")
            expect(wire).not.toContain("ROLL_CALL_A_REFRESH")
            expect(log.mock.calls.flat().join(" ")).toContain("synthetic SDK response")

            const hostile = ProviderTest.model({
              id: ModelV2.ID.make("gpt-roll-call-config-poison"),
              providerID: ProviderV2.ID.openai,
              api: { id: "gpt-roll-call-config-poison", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
              headers: { Authorization: "Bearer ROLL_CALL_CONFIG_POISON" },
            })
            yield* Effect.promise(async () =>
              handle({
                ...args,
                filter: "openai/gpt-roll-call-config-poison",
                list: async () => ({ openai: { ...info, models: { [hostile.id]: hostile } } }),
              }),
            )
            expect(state.calls).toHaveLength(1)
            expect(wire).not.toContain("ROLL_CALL_CONFIG_POISON")

            yield* Effect.promise(async () =>
              expect(
                handle({
                  ...args,
                  account: "acct_missing_roll_call",
                  list: async () => ({ openai: { ...info, models: { "gpt-roll-call": item } } }),
                }),
              ).rejects.toThrow("unavailable"),
            )
            yield* Effect.promise(async () =>
              expect(
                handle({
                  ...args,
                  account: undefined,
                  list: async () => ({ openai: { ...info, models: { "gpt-roll-call": item } } }),
                }),
              ).rejects.toThrow(),
            )
            yield* Effect.promise(() =>
              runInstance({
                directory: dir.directory,
                fn: () =>
                  AppRuntime.runPromise(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(a.id))),
              }),
            )
            yield* Effect.promise(async () =>
              expect(
                handle({
                  ...args,
                  list: async () => ({ openai: { ...info, models: { "gpt-roll-call": item } } }),
                }),
              ).rejects.toThrow("unavailable"),
            )
            expect(state.calls).toHaveLength(1)
          } finally {
            log.mockRestore()
            yield* Effect.promise(() =>
              runInstance({
                directory: dir.directory,
                fn: () =>
                  AppRuntime.runPromise(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(a.id))),
              }),
            )
            yield* Effect.promise(() =>
              runInstance({
                directory: dir.directory,
                fn: () =>
                  AppRuntime.runPromise(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(b.id))),
              }),
            )
          }
        }),
      (state) =>
        Effect.promise(async () => {
          try {
            await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeDirectory(dir.directory)))
          } finally {
            process.chdir(state.cwd)
            globalThis.fetch = state.fetch
            if (state.flag === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
            else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = state.flag
            if (state.native === undefined) delete process.env.KILO_EXPERIMENTAL_NATIVE_LLM
            else process.env.KILO_EXPERIMENTAL_NATIVE_LLM = state.native
            if (state.key === undefined) delete process.env.OPENAI_API_KEY
            else process.env.OPENAI_API_KEY = state.key
            if (state.auth === undefined) delete process.env.KILO_AUTH_CONTENT
            else process.env.KILO_AUTH_CONTENT = state.auth
          }
        }),
    )
  }),
)
