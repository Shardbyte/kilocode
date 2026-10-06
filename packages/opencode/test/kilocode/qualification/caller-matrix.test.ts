import { afterEach, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppRuntime } from "@/effect/app-runtime"
import { CommitMessageRuntime, generateCommitMessage, prepareCommitMessage } from "@/kilocode/commit-message/generate"
import { EnhancePromptRuntime, enhancePrompt, prepareEnhancePrompt } from "@/kilocode/enhance-prompt"
import { provide as provideInstance } from "@/kilocode/instance"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { Session } from "@/session/session"
import { ProviderTest } from "../../fake/provider"
import { tmpdir } from "../../fixture/fixture"

const env = ["KILO_EXPERIMENTAL_PROVIDER_PROFILES", "OPENAI_API_KEY", "KILO_AUTH_CONTENT", "OPENAI_BASE_URL"] as const
const prior = Object.fromEntries(env.map((key) => [key, process.env[key]]))
const model = ProviderTest.model({
  id: ModelV2.ID.make("gpt-caller-matrix"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-caller-matrix", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
})

afterEach(() => {
  for (const key of env) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
})

const store = <A, E>(effect: Effect.Effect<A, E, ProviderAccountProfiles.Service>) => AppRuntime.runPromise(effect)

test.serial(
  "commit and enhancement callers preserve explicit account/model identity against ambient and default mutations",
  async () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    process.env.OPENAI_API_KEY = "CALLER_MATRIX_ENV_POISON"
    process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "CALLER_MATRIX_LEGACY_POISON" } })
    process.env.OPENAI_BASE_URL = "https://caller-matrix.invalid/v1"
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/caller-matrix.ts`, "export const change = true\n")

    await provideInstance({
      directory: tmp.path,
      fn: async () => {
        const acct = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "caller matrix",
              remoteID: "caller-matrix-remote",
              credential: {
                access: "CALLER_MATRIX_PROFILE_ACCESS",
                refresh: "CALLER_MATRIX_PROFILE_REFRESH",
                expires: Date.now() + 60_000,
              },
            }),
          ),
        )
        const second = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "mutated default",
              credential: {
                access: "CALLER_MATRIX_SECOND_ACCESS",
                refresh: "CALLER_MATRIX_SECOND_REFRESH",
                expires: Date.now() + 60_000,
              },
            }),
          ),
        )
        await store(
          ProviderAccountProfiles.Service.use((profiles) => profiles.selectDefault("openai", "chatgpt-oauth", acct.id)),
        )

        const calls: Array<{ caller: string; model: string; account: string; mode: string }> = []
        const commitModel = spyOn(CommitMessageRuntime, "model").mockImplementation(async (ref) => {
          return ProviderTest.model({ ...model, id: ModelV2.ID.make(ref?.modelID ?? model.id) })
        })
        const commitResolve = CommitMessageRuntime.resolve.bind(CommitMessageRuntime)
        const commitAuthority = spyOn(CommitMessageRuntime, "resolve").mockImplementation(async (input) => {
          const authority = await commitResolve(input)
          calls.push({
            caller: "commit",
            model: input.model.id,
            account: authority.mode === "profile" ? authority.profileID : "",
            mode: authority.mode,
          })
          return authority
        })
        const commitGenerate = spyOn(CommitMessageRuntime, "generate").mockResolvedValue("synthetic commit")
        const enhanceModel = spyOn(EnhancePromptRuntime, "model").mockImplementation(async (ref) => ({
          model: ProviderTest.model({ ...model, id: ModelV2.ID.make(ref?.modelID ?? model.id) }),
        }))
        const enhanceResolve = EnhancePromptRuntime.authority.bind(EnhancePromptRuntime)
        const enhanceAuthority = spyOn(EnhancePromptRuntime, "authority").mockImplementation(async (input) => {
          const authority = await enhanceResolve(input)
          calls.push({
            caller: "enhance",
            model: input.model.id,
            account: authority.mode === "profile" ? authority.profileID : "",
            mode: authority.mode,
          })
          return authority
        })
        const enhanceLanguage = spyOn(EnhancePromptRuntime, "language").mockResolvedValue({} as never)
        const enhanceGenerate = spyOn(EnhancePromptRuntime, "generate").mockResolvedValue({
          text: "synthetic enhancement",
        } as never)

        try {
          const preparedCommit = await prepareCommitMessage()
          const preparedEnhance = await prepareEnhancePrompt()
          const commitRef = { providerID: "openai", modelID: "caller-matrix-commit" }
          const enhanceRef = { providerID: "openai", modelID: "caller-matrix-enhance" }

          await generateCommitMessage({
            path: tmp.path,
            model: commitRef,
            accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
          })
          await enhancePrompt("synthetic prompt", {
            model: enhanceRef,
            accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
          })

          await store(
            ProviderAccountProfiles.Service.use((profiles) =>
              profiles.selectDefault("openai", "chatgpt-oauth", second.id),
            ),
          )
          process.env.OPENAI_API_KEY = "CALLER_MATRIX_CHANGED_ENV_POISON"
          process.env.KILO_AUTH_CONTENT = JSON.stringify({
            openai: { type: "api", key: "CALLER_MATRIX_CHANGED_LEGACY_POISON" },
          })

          await generateCommitMessage({
            path: tmp.path,
            model: commitRef,
            accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
          })
          await enhancePrompt("synthetic prompt", {
            model: enhanceRef,
            accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
          })

          expect(preparedCommit).toMatchObject({ profilesEnabled: true, requiresAccountContext: true })
          expect(preparedEnhance).toMatchObject({ profilesEnabled: true, requiresAccountContext: true })
          expect(calls).toEqual([
            { caller: "commit", model: "caller-matrix-commit", account: acct.id, mode: "profile" },
            { caller: "enhance", model: "caller-matrix-enhance", account: acct.id, mode: "profile" },
            { caller: "commit", model: "caller-matrix-commit", account: acct.id, mode: "profile" },
            { caller: "enhance", model: "caller-matrix-enhance", account: acct.id, mode: "profile" },
          ])
          expect(commitGenerate).toHaveBeenCalledTimes(2)
          expect(enhanceGenerate).toHaveBeenCalledTimes(2)
          expect(enhanceLanguage).toHaveBeenCalledTimes(2)
        } finally {
          commitModel.mockRestore()
          commitAuthority.mockRestore()
          commitGenerate.mockRestore()
          enhanceModel.mockRestore()
          enhanceAuthority.mockRestore()
          enhanceLanguage.mockRestore()
          enhanceGenerate.mockRestore()
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(acct.id)))
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(second.id)))
        }
      },
    })
  },
)

test.serial("enhancement caller sends the selected profile through the real OpenAI SDK transport", async () => {
  const prior = {
    profiles: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
    key: process.env.OPENAI_API_KEY,
    auth: process.env.KILO_AUTH_CONTENT,
    base: process.env.OPENAI_BASE_URL,
    fetch: globalThis.fetch,
  }
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.OPENAI_API_KEY = "CALLER_SDK_ENV_POISON"
  process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "CALLER_SDK_LEGACY_POISON" } })
  delete process.env.OPENAI_BASE_URL
  const requests: Array<{ url: string; headers: Headers; body: string }> = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      })
      return Response.json({
        id: "resp_caller_matrix",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-caller-matrix",
        output: [
          {
            id: "msg_caller_matrix",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "rewritten by sdk", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    },
    { preconnect: prior.fetch.preconnect },
  )
  const catalog = {
    id: "gpt-caller-matrix",
    name: "Caller matrix model",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: false,
    release_date: "2025-01-01",
    limit: { context: 100000, output: 10000 },
    cost: { input: 0, output: 0 },
    options: {},
  }
  await using tmp = await tmpdir({
    git: true,
    config: {
      model: "openai/gpt-caller-matrix",
      small_model: "openai/gpt-caller-matrix",
      provider: { openai: { models: { "gpt-caller-matrix": catalog } } },
    },
  })
  const modelSelect = EnhancePromptRuntime.model.bind(EnhancePromptRuntime)
  const select = spyOn(EnhancePromptRuntime, "model").mockImplementation((ref) => modelSelect(ref))
  try {
    await provideInstance({
      directory: tmp.path,
      fn: async () => {
        const acct = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "SDK dispatch account",
              remoteID: "caller-sdk-profile",
              credential: {
                access: "CALLER_SDK_PROFILE_ACCESS",
                refresh: "CALLER_SDK_PROFILE_REFRESH",
                expires: Date.now() + 60_000,
                accountID: "caller-sdk-profile",
              },
            }),
          ),
        )
        const next = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Default B",
              remoteID: "caller-sdk-profile-B",
              credential: {
                access: "CALLER_SDK_PROFILE_B_ACCESS",
                refresh: "CALLER_SDK_PROFILE_B_REFRESH",
                expires: Date.now() + 60_000,
                accountID: "caller-sdk-profile-B",
              },
            }),
          ),
        )
        await store(
          ProviderAccountProfiles.Service.use((profiles) => profiles.selectDefault("openai", "chatgpt-oauth", acct.id)),
        )
        try {
          await store(
            ProviderAccountProfiles.Service.use((profiles) => profiles.clearDefault("openai", "chatgpt-oauth")),
          )
          const source = await AppRuntime.runPromise(
            Session.Service.use((sessions) =>
              Effect.gen(function* () {
                const source = yield* sessions.create()
                yield* sessions.assignBinding({ sessionID: source.id, provider: "openai", profileID: acct.id })
                return source
              }),
            ),
          )
          const prepared = await prepareEnhancePrompt()
          expect(prepared.model).toEqual({ providerID: ProviderV2.ID.openai, modelID: model.id })
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.rename(acct.id, "Renamed source A")))
          await store(
            ProviderAccountProfiles.Service.use((profiles) =>
              profiles.selectDefault("openai", "chatgpt-oauth", next.id),
            ),
          )
          await Bun.write(
            `${tmp.path}/opencode.json`,
            JSON.stringify({
              model: "openai/gpt-mutated-default",
              small_model: "openai/gpt-mutated-default",
              provider: {
                openai: {
                  models: {
                    "gpt-caller-matrix": catalog,
                    "gpt-mutated-default": { ...catalog, id: "gpt-mutated-default", name: "Mutated default" },
                  },
                },
              },
            }),
          )
          await expect(enhancePrompt("draft", { model: prepared.model })).rejects.toMatchObject({
            name: "UtilityAccountError",
            code: "selection-required",
          })
          expect(
            await enhancePrompt("draft", {
              model: prepared.model,
              accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
            }),
          ).toBe("rewritten by sdk")
          expect(
            await enhancePrompt("source draft", {
              model: prepared.model,
              accountContext: { kind: "session", sourceSessionID: source.id },
            }),
          ).toBe("rewritten by sdk")
          const sdk = requests.filter((request) =>
            request.url.startsWith("https://chatgpt.com/backend-api/codex/responses"),
          )
          expect(sdk).toHaveLength(2)
          expect(
            sdk.every((request) => request.headers.get("authorization") === "Bearer CALLER_SDK_PROFILE_ACCESS"),
          ).toBe(true)
          expect(sdk.every((request) => request.headers.get("chatgpt-account-id") === "caller-sdk-profile")).toBe(true)
          expect(sdk.map((request) => JSON.parse(request.body).model)).toEqual([model.id, model.id])
          expect(JSON.stringify(sdk)).not.toContain("POISON")
          expect(JSON.stringify(sdk)).not.toContain("PROFILE_REFRESH")
          select.mockRejectedValue(new Error("captured model is no longer available"))
          await expect(
            enhancePrompt("unavailable", {
              model: prepared.model,
              accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
            }),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "model-unavailable" })
          expect(
            requests.filter((request) => request.url.startsWith("https://chatgpt.com/backend-api/codex/responses")),
          ).toHaveLength(2)
          select.mockImplementation((ref) => modelSelect(ref))
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(acct.id)))
          await expect(
            enhancePrompt("draft", {
              model: prepared.model,
              accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: acct.id },
            }),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "account-unavailable" })
          expect(
            requests.filter((request) => request.url.startsWith("https://chatgpt.com/backend-api/codex/responses")),
          ).toHaveLength(2)
        } finally {
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(acct.id)))
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(next.id)))
        }
      },
    })
  } finally {
    select.mockRestore()
    globalThis.fetch = prior.fetch
    if (prior.profiles === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.profiles
    if (prior.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prior.key
    if (prior.auth === undefined) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = prior.auth
    if (prior.base === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prior.base
  }
})

test.serial("enhancement rejects provider config credential overrides without dispatching", async () => {
  const prior = {
    profiles: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
    key: process.env.OPENAI_API_KEY,
    auth: process.env.KILO_AUTH_CONTENT,
    base: process.env.OPENAI_BASE_URL,
    fetch: globalThis.fetch,
  }
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.OPENAI_API_KEY = "CALLER_CONFIG_ENV_POISON"
  process.env.KILO_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "CALLER_CONFIG_LEGACY_POISON" } })
  process.env.OPENAI_BASE_URL = "https://caller-config-env.invalid/v1"
  const requests: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
      return Response.json({})
    },
    { preconnect: prior.fetch.preconnect },
  )
  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: {
        openai: {
          options: {
            apiKey: "CALLER_CONFIG_KEY_POISON",
            baseURL: "https://caller-config.invalid/v1",
            headers: { authorization: "Bearer CALLER_CONFIG_HEADER_POISON" },
          },
        },
      },
    },
  })
  const select = spyOn(EnhancePromptRuntime, "model").mockResolvedValue({ model })
  try {
    await provideInstance({
      directory: tmp.path,
      fn: async () => {
        const acct = await store(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Config source account",
              remoteID: "caller-config-profile",
              credential: {
                access: "CALLER_CONFIG_PROFILE_ACCESS",
                refresh: "CALLER_CONFIG_PROFILE_REFRESH",
                expires: Date.now() + 60_000,
                accountID: "caller-config-profile",
              },
            }),
          ),
        )
        try {
          await store(
            ProviderAccountProfiles.Service.use((profiles) => profiles.clearDefault("openai", "chatgpt-oauth")),
          )
          const source = await AppRuntime.runPromise(
            Session.Service.use((sessions) =>
              Effect.gen(function* () {
                const source = yield* sessions.create()
                yield* sessions.assignBinding({ sessionID: source.id, provider: "openai", profileID: acct.id })
                return source
              }),
            ),
          )
          await expect(
            enhancePrompt("source draft", {
              model: { providerID: "openai", modelID: model.id },
              accountContext: { kind: "session", sourceSessionID: source.id },
            }),
          ).rejects.toMatchObject({
            name: "UtilityAccountError",
            code: "account-unavailable",
          })
          expect(
            requests.filter((url) => url.startsWith("https://chatgpt.com/backend-api/codex/responses")),
          ).toHaveLength(0)
          expect(JSON.stringify(requests)).not.toContain("CALLER_CONFIG_PROFILE_ACCESS")
          expect(JSON.stringify(requests)).not.toContain("CALLER_CONFIG_KEY_POISON")
        } finally {
          await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(acct.id)))
        }
      },
    })
  } finally {
    select.mockRestore()
    globalThis.fetch = prior.fetch
    if (prior.profiles === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.profiles
    if (prior.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prior.key
    if (prior.auth === undefined) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = prior.auth
    if (prior.base === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prior.base
  }
})

test.serial("source-only utility operations resolve only real same-project bound sessions", async () => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  await using tmp = await tmpdir({ git: true })
  await provideInstance({
    directory: tmp.path,
    fn: async () => {
      const acct = await store(
        ProviderAccountProfiles.Service.use((profiles) =>
          profiles.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: "source authority",
            credential: {
              access: "SOURCE_MATRIX_ACCESS",
              refresh: "SOURCE_MATRIX_REFRESH",
              expires: Date.now() + 60_000,
            },
          }),
        ),
      )
      try {
        await store(ProviderAccountProfiles.Service.use((profiles) => profiles.clearDefault("openai", "chatgpt-oauth")))
        const source = await AppRuntime.runPromise(
          Session.Service.use((sessions) =>
            Effect.gen(function* () {
              const source = yield* sessions.create()
              yield* sessions.assignBinding({ sessionID: source.id, provider: "openai", profileID: acct.id })
              return source
            }),
          ),
        )
        expect(
          await AppRuntime.runPromise(Session.Service.use((sessions) => sessions.binding(source.id))),
        ).toMatchObject({
          providers: { openai: { mode: "profile", profileID: acct.id } },
        })
        for (const operation of ["branch-name", "title", "memory", "enhance-prompt"] as const) {
          const identity = await AppRuntime.runPromise(
            UtilityAccount.resolve({
              operation,
              model: { providerID: "openai", id: "gpt-source-matrix" },
              context: { kind: "session", sourceSessionID: source.id },
            }),
          )
          expect(identity).toMatchObject({ operation, mode: "profile", profileID: acct.id, sourceSessionID: source.id })
        }
        for (const operation of ["commit-message", "agent-generation", "roll-call"] as const) {
          await expect(
            AppRuntime.runPromise(
              UtilityAccount.resolve({
                operation,
                model: { providerID: "openai", id: "gpt-source-matrix" },
                context: { kind: "session", sourceSessionID: source.id },
              }),
            ),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "context-mismatch" })
        }
        for (const sourceSessionID of ["ses_smuggled_source", "ses_never_created"]) {
          await expect(
            AppRuntime.runPromise(
              UtilityAccount.resolve({
                operation: "title",
                model: { providerID: "openai", id: "gpt-source-matrix" },
                context: { kind: "session", sourceSessionID },
              }),
            ),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "source-unavailable" })
        }
      } finally {
        await store(ProviderAccountProfiles.Service.use((profiles) => profiles.remove(acct.id)))
      }
    },
  })
})
