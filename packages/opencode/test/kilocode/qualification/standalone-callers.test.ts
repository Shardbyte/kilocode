import { afterEach, beforeEach, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CommitMessagePayload } from "@/kilocode/utility-generation-schema"
import { generateCommitMessage } from "@/kilocode/commit-message/generate"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ModelsDev } from "@/provider/models"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"
import { Effect, Layer } from "effect"
import { TestInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "@/effect/app-runtime"
import { provide as provideInstance } from "@/kilocode/instance"

const env = ["KILO_EXPERIMENTAL_PROVIDER_PROFILES", "OPENAI_API_KEY", "KILO_AUTH_CONTENT", "OPENAI_BASE_URL"] as const
let prior = Object.fromEntries(env.map((key) => [key, process.env[key]]))
let fetcher = globalThis.fetch
const model = { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-5") }

beforeEach(() => {
  prior = Object.fromEntries(env.map((key) => [key, process.env[key]]))
  fetcher = globalThis.fetch
})

afterEach(() => {
  for (const key of env) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
  globalThis.fetch = fetcher
})

const cfg = {
  provider: {
    openai: {
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      options: {} as Record<string, unknown>,
      models: { "gpt-5": { name: "GPT-5", limit: { context: 128000, output: 4096 } } },
    },
  },
}

function graphFor(config: typeof cfg) {
  return testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Agent.node,
        LLM.node,
        Session.node,
        SessionProjector.node,
        Database.node,
        EventV2Bridge.node,
        CrossSpawnSpawner.node,
        ProviderAccountProfiles.node,
        SessionBinding.node,
        Provider.node,
        Config.node,
        ModelsDev.node,
      ]),
      [
        [Config.node, TestConfig.layer({ get: () => Effect.succeed(config) })],
        [ModelsDev.node, Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed({}) })],
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
        [
          Auth.node,
          Layer.mock(Auth.Service)({
            get: () =>
              Effect.succeed(
                new Auth.Oauth({
                  type: "oauth",
                  access: "LEGACY_OAUTH_ACCESS_POISON",
                  refresh: "LEGACY_OAUTH_REFRESH_POISON",
                  expires: Date.now() + 60_000,
                  accountId: "legacy-oauth-account",
                }),
              ),
            all: () =>
              Effect.succeed({
                openai: new Auth.Oauth({
                  type: "oauth",
                  access: "LEGACY_OAUTH_ACCESS_POISON",
                  refresh: "LEGACY_OAUTH_REFRESH_POISON",
                  expires: Date.now() + 60_000,
                  accountId: "legacy-oauth-account",
                }),
              }),
          }),
        ],
        [
          Plugin.node,
          Layer.mock(Plugin.Service)({
            list: () => Effect.succeed([]),
            trigger: (name, _input, output) =>
              Effect.sync(() => {
                if (name !== "chat.headers" || typeof output !== "object" || output == null) return output
                const headers =
                  "headers" in output && typeof output.headers === "object" && output.headers != null
                    ? output.headers
                    : {}
                Object.assign(output, { headers: { ...headers, authorization: "Bearer PLUGIN_HEADER_POISON" } })
                return output
              }),
          }),
        ],
        [MCP.node, Layer.mock(MCP.Service)({})],
        [Skill.node, Layer.mock(Skill.Service)({ dirs: () => Effect.succeed([]) })],
      ],
    ),
  )
}

const graph = graphFor(cfg)

const store = <A, E>(effect: Effect.Effect<A, E, ProviderAccountProfiles.Service>) => AppRuntime.runPromise(effect)

function synthetic(calls: Array<{ url: string; headers: Headers; body: string }>) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "",
      })
      const text = JSON.stringify({
        identifier: "synthetic-agent",
        whenToUse: "qualification",
        systemPrompt: "synthetic",
      })
      const events = [
        {
          type: "response.created",
          sequence_number: 1,
          response: { id: "resp_standalone_qualification", created_at: 1, model: "gpt-5" },
        },
        {
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 0,
          item: { type: "message", id: "msg_standalone_qualification" },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 3,
          item_id: "msg_standalone_qualification",
          delta: text,
        },
        {
          type: "response.output_item.done",
          sequence_number: 4,
          output_index: 0,
          item: { type: "message", id: "msg_standalone_qualification" },
        },
        {
          type: "response.completed",
          sequence_number: 5,
          response: {
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ]
      return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: fetcher.preconnect },
  )
}

function sdk(calls: Array<{ url: string; headers: Headers; body: string }>) {
  return calls.filter((call) => call.url.startsWith("https://chatgpt.com/backend-api/codex/responses"))
}

function wire(calls: Parameters<typeof synthetic>[0]) {
  return JSON.stringify(calls.map((call) => ({ ...call, headers: Object.fromEntries(call.headers) })))
}

test("standalone commit-message and Agent.generate use explicit account A through real SDK transport", async () => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.OPENAI_API_KEY = "STANDALONE_ENV_POISON"
  process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "STANDALONE_LEGACY_POISON" } })
  const calls: Array<{ url: string; headers: Headers; body: string }> = []
  synthetic(calls)
  await using tmp = await tmpdir({
    git: true,
    init: (dir) => Bun.write(`${dir}/change.ts`, "export const changed = true\n"),
  })

  await provideInstance({
    directory: tmp.path,
    fn: async () => {
      const a = await store(
        ProviderAccountProfiles.Service.use((profiles) =>
          profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "standalone A",
            remoteID: "standalone-remote-A",
            credential: {
              access: "STANDALONE_A_ACCESS",
              refresh: "STANDALONE_A_REFRESH",
              expires: Date.now() + 60_000,
              accountID: "standalone-remote-A",
            },
          }),
        ),
      )
      const ids = [a.id]
      try {
        const b = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "standalone B",
              remoteID: "standalone-remote-B",
              credential: {
                access: "STANDALONE_B_ACCESS",
                refresh: "STANDALONE_B_REFRESH",
                expires: Date.now() + 60_000,
                accountID: "standalone-remote-B",
              },
            }),
          ),
        )
        ids.push(b.id)
        await store(
          ProviderAccountProfiles.Service.use((profiles) => profiles.selectDefault("openai", "chatgpt-oauth", a.id)),
        )
        const context = {
          kind: "account" as const,
          providerID: "openai" as const,
          authMode: "chatgpt-oauth" as const,
          accountID: a.id,
        }
        expect(
          await generateCommitMessage({ path: tmp.path, model, accountContext: context }).catch((err) => {
            throw new Error(`${String(err)}; transport=${JSON.stringify(calls.map((call) => call.url))}`)
          }),
        ).toMatchObject({
          message: expect.any(String),
        })

        const bad = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "missing account test",
              credential: { access: "UNSELECTED_ACCESS", refresh: "UNSELECTED_REFRESH", expires: Date.now() + 60_000 },
            }),
          ),
        )
        ids.push(bad.id)
        await expect(
          generateCommitMessage({
            path: tmp.path,
            model,
            accountContext: { ...context, accountID: "pacc_missing_standalone" },
          }),
        ).rejects.toMatchObject({ name: "UtilityAccountError", code: "account-unavailable" })
        await expect(generateCommitMessage({ path: tmp.path, model })).rejects.toMatchObject({
          name: "UtilityAccountError",
          code: "selection-required",
        })
        expect(sdk(calls)).toHaveLength(1)

        await store(
          ProviderAccountProfiles.Service.use((profiles) => profiles.selectDefault("openai", "chatgpt-oauth", b.id)),
        )
        process.env.OPENAI_API_KEY = "STANDALONE_CHANGED_ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({
          openai: { type: "api", key: "STANDALONE_CHANGED_LEGACY_POISON" },
        })
        expect(await generateCommitMessage({ path: tmp.path, model, accountContext: context })).toMatchObject({
          message: expect.any(String),
        })
        expect(sdk(calls)).toHaveLength(2)
        expect(sdk(calls).map((call) => call.headers.get("authorization"))).toEqual([
          "Bearer STANDALONE_A_ACCESS",
          "Bearer STANDALONE_A_ACCESS",
        ])
        expect(sdk(calls).map((call) => call.headers.get("chatgpt-account-id"))).toEqual([
          "standalone-remote-A",
          "standalone-remote-A",
        ])
        expect(sdk(calls).map((call) => JSON.parse(call.body).model)).toEqual(["gpt-5", "gpt-5"])
        expect(wire(sdk(calls))).not.toContain("STANDALONE_A_REFRESH")
        expect(wire(sdk(calls))).not.toContain("STANDALONE_B_ACCESS")
        expect(wire(sdk(calls))).not.toContain("PLUGIN_HEADER_POISON")

        await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(a.id)))
        await expect(generateCommitMessage({ path: tmp.path, model, accountContext: context })).rejects.toMatchObject({
          name: "UtilityAccountError",
          code: "account-unavailable",
        })
        expect(sdk(calls)).toHaveLength(2)
        expect(wire(calls)).not.toContain("POISON")
        expect(wire(calls)).not.toContain("REFRESH")
      } finally {
        for (const id of ids) await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(id)))
      }
    },
  })
})

graph.instance("Agent.generate resolves explicit account and transports using its real SDK provider", () =>
  Effect.gen(function* () {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    process.env.OPENAI_API_KEY = "AGENT_STANDALONE_ENV_POISON"
    process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "AGENT_STANDALONE_LEGACY_POISON" } })
    const calls: Array<{ url: string; headers: Headers; body: string }> = []
    synthetic(calls)

    const profiles = yield* ProviderAccountProfiles.Service
    const a = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Agent A",
      remoteID: "agent-remote-A",
      credential: {
        access: "AGENT_A_ACCESS",
        refresh: "AGENT_A_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "agent-remote-A",
      },
    })
    yield* Effect.addFinalizer(() => profiles.remove(a.id).pipe(Effect.orDie))
    const b = yield* profiles.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Agent B",
      remoteID: "agent-remote-B",
      credential: {
        access: "AGENT_B_ACCESS",
        refresh: "AGENT_B_REFRESH",
        expires: Date.now() + 60_000,
        accountID: "agent-remote-B",
      },
    })
    yield* Effect.addFinalizer(() => profiles.remove(b.id).pipe(Effect.orDie))
    yield* profiles.selectDefault("openai", "chatgpt-oauth", a.id)
    const agent = yield* Agent.Service
    const context = {
      kind: "account" as const,
      providerID: "openai" as const,
      authMode: "chatgpt-oauth" as const,
      accountID: a.id,
    }
    const generated = yield* agent.generate({
      description: "synthetic qualification",
      model,
      utilityContext: {
        ...context,
        access: "ATTACKER_ACCESS",
        refresh: "ATTACKER_REFRESH",
        apiKey: "ATTACKER_API_KEY",
      } as never,
    })
    expect(generated.identifier).toBe("synthetic-agent")
    expect(sdk(calls)).toHaveLength(1)

    const before = sdk(calls).length
    const missing = yield* agent
      .generate({
        description: "missing account",
        model,
        utilityContext: {
          ...context,
          accountID: "pacc_missing_agent",
          access: "ATTACKER_ACCESS",
          apiKey: "ATTACKER_API_KEY",
        } as never,
      })
      .pipe(Effect.exit)
    expect(missing._tag).toBe("Failure")
    const absent = yield* agent.generate({ description: "no account", model }).pipe(Effect.exit)
    expect(absent._tag).toBe("Failure")
    const session = yield* agent
      .generate({
        description: "hostile session context",
        model,
        utilityContext: { kind: "session", sourceSessionID: "ses_hostile" } as never,
      })
      .pipe(Effect.exit)
    expect(session._tag).toBe("Failure")
    expect(sdk(calls)).toHaveLength(before)

    yield* profiles.selectDefault("openai", "chatgpt-oauth", b.id)
    process.env.OPENAI_API_KEY = "AGENT_CHANGED_ENV_POISON"
    process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "AGENT_CHANGED_LEGACY_POISON" } })
    const again = yield* agent.generate({
      description: "explicit A after mutations",
      model,
      utilityContext: context,
    })
    expect(again.identifier).toBe("synthetic-agent")
    expect(sdk(calls)).toHaveLength(2)
    expect(sdk(calls).map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer AGENT_A_ACCESS",
      "Bearer AGENT_A_ACCESS",
    ])
    expect(sdk(calls).map((call) => call.headers.get("chatgpt-account-id"))).toEqual([
      "agent-remote-A",
      "agent-remote-A",
    ])
    expect(wire(sdk(calls))).not.toContain("ATTACKER_")
    yield* profiles.remove(a.id)
    const deleted = yield* agent
      .generate({ description: "deleted account", model, utilityContext: context })
      .pipe(Effect.exit)
    expect(deleted._tag).toBe("Failure")
    expect(sdk(calls)).toHaveLength(2)
    expect(wire(calls)).not.toContain("POISON")
    expect(wire(calls)).not.toContain("REFRESH")
  }),
)

for (const [key, value] of [
  ["apiKey", "CONFIG_API_KEY_POISON"],
  ["baseURL", "https://config-base.invalid/v1"],
  ["headers", { authorization: "Bearer CONFIG_HEADER_POISON" }],
] as const) {
  const isolated = graphFor({
    provider: {
      openai: { ...cfg.provider.openai, options: { [key]: value } },
    },
  })
  isolated.instance(
    `standalone callers reject provider ${key} override before SDK transport`,
    () =>
      Effect.gen(function* () {
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        process.env.OPENAI_API_KEY = "CONFIG_ENV_POISON"
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "CONFIG_LEGACY_POISON" } })
        const calls: Array<{ url: string; headers: Headers; body: string }> = []
        synthetic(calls)
        const dir = yield* TestInstance
        const profiles = yield* ProviderAccountProfiles.Service
        const account = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: `blocked-${key}`,
          remoteID: `blocked-remote-${key}`,
          credential: {
            access: "BLOCKED_PROFILE_ACCESS",
            refresh: "BLOCKED_PROFILE_REFRESH",
            expires: Date.now() + 60_000,
            accountID: `blocked-remote-${key}`,
          },
        })
        yield* Effect.addFinalizer(() => profiles.remove(account.id).pipe(Effect.orDie))
        const context = {
          kind: "account" as const,
          providerID: "openai" as const,
          authMode: "chatgpt-oauth" as const,
          accountID: account.id,
        }
        const commit = yield* Effect.promise(() =>
          provideInstance({
            directory: dir.directory,
            fn: () =>
              generateCommitMessage({ path: dir.directory, model, accountContext: context }).then(
                () => undefined,
                (err: unknown) => err,
              ),
          }),
        )
        expect(commit).toBeInstanceOf(Error)
        if (commit instanceof Error)
          expect(commit).toMatchObject({ name: "UtilityAccountError", code: "account-unavailable" })

        const agent = yield* Agent.Service
        const denied = yield* agent
          .generate({ description: `blocked ${key}`, model, utilityContext: context })
          .pipe(Effect.exit)
        expect(denied._tag).toBe("Failure")
        if (denied._tag === "Failure")
          expect(String(denied.cause)).toContain(
            "Codex account profiles cannot be combined with provider API key, base URL, or authorization-header overrides",
          )
        expect(sdk(calls)).toHaveLength(0)
        expect(wire(calls)).not.toContain("BLOCKED_PROFILE_ACCESS")
        expect(wire(calls)).not.toContain("CONFIG_")
      }),
    {
      git: true,
      init: (dir) => Effect.promise(() => Bun.write(`${dir}/change.ts`, "export const changed = true\n")),
    },
  )
}

test("standalone DTO rejects session authority and extra credential fields before use", () => {
  const base = {
    path: "/tmp/repo",
    accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "pacc_synthetic" },
  }
  expect(() => CommitMessagePayload.make({ ...base, apiKey: "POISON" } as never)).toThrow()
  expect(() =>
    CommitMessagePayload.make({ ...base, accountContext: { ...base.accountContext, accessToken: "POISON" } } as never),
  ).toThrow()
  expect(() =>
    CommitMessagePayload.make({
      ...base,
      accountContext: { kind: "session", sourceSessionID: "ses_hostile" },
    } as never),
  ).toThrow()
})
