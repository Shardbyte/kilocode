import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppRuntime } from "../../src/effect/app-runtime"
import {
  EnhancePromptRuntime,
  enhancePrompt,
  INSTRUCTION,
  prepareEnhancePrompt,
} from "../../src/kilocode/enhance-prompt"
import { provide as provideInstance } from "../../src/kilocode/instance"
import { Session } from "../../src/session/session"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"

const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const api = process.env.OPENAI_API_KEY
const model = ProviderTest.model({
  id: ModelV2.ID.make("gpt-enhance-authority"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-enhance-authority", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
})

afterEach(() => {
  if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
  if (api === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = api
})

const service = <A, E>(effect: Effect.Effect<A, E, ProviderAccountProfiles.Service>) => AppRuntime.runPromise(effect)
const binding = (profileID: string) =>
  SessionBinding.set(undefined, {
    version: 1,
    providers: { openai: { mode: "profile", profileID, authMode: "chatgpt-oauth", source: "explicit" } },
  })

describe("enhance prompt authority", () => {
  test("preserves existing-session authority, explicit standalone choices and OAuth transport constraints", async () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    process.env.OPENAI_API_KEY = "POISON_ENV_KEY"
    await using tmp = await tmpdir({ git: true })

    await provideInstance({
      directory: tmp.path,
      fn: async () => {
        const a = await service(
          ProviderAccountProfiles.Service.use((store) =>
            store.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Enhance source",
              credential: { access: "POISON_ACCESS_A", refresh: "POISON_REFRESH_A", expires: Date.now() + 60_000 },
            }),
          ),
        )
        const b = await service(
          ProviderAccountProfiles.Service.use((store) =>
            store.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Enhance standalone",
              credential: { access: "POISON_ACCESS_B", refresh: "POISON_REFRESH_B", expires: Date.now() + 60_000 },
            }),
          ),
        )
        const source = await AppRuntime.runPromise(
          Session.Service.use((sessions) => sessions.create({ metadata: binding(a.id) })),
        )
        await service(
          ProviderAccountProfiles.Service.use((store) => store.selectDefault("openai", "chatgpt-oauth", b.id)),
        )
        const list = await AppRuntime.runPromise(Session.Service.use((sessions) => sessions.list()))
        const profiles: Array<string | undefined> = []
        const models: Array<string | undefined> = []
        const identities: Array<{ mode: string; profileID?: string; sourceSessionID?: string; id: string }> = []
        const requests: Array<Parameters<typeof EnhancePromptRuntime.generate>[0]> = []
        const resolve = EnhancePromptRuntime.authority.bind(EnhancePromptRuntime)
        const modelSpy = spyOn(EnhancePromptRuntime, "model").mockImplementation(async (selected) => {
          const id = selected?.modelID
          models.push(id)
          if (selected) expect(selected.providerID).toBe("openai")
          return { model: ProviderTest.model({ ...model, id: ModelV2.ID.make(id ?? model.id) }) }
        })
        const lang = spyOn(EnhancePromptRuntime, "language").mockImplementation(async (_model, profileID) => {
          profiles.push(profileID)
          return {} as never
        })
        const authority = spyOn(EnhancePromptRuntime, "authority").mockImplementation(async (input) => {
          const identity = await resolve(input)
          identities.push(identity)
          return identity
        })
        const generate = spyOn(EnhancePromptRuntime, "generate").mockImplementation(async (input) => {
          requests.push(input)
          return { text: "rewritten" } as never
        })

        try {
          expect(
            await enhancePrompt("improve this", { accountContext: { kind: "session", sourceSessionID: source.id } }),
          ).toBe("rewritten")
          expect(
            await enhancePrompt("improve this", {
              model: { providerID: "openai", modelID: "selected-enhancement-model" },
              accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
            }),
          ).toBe("rewritten")
          expect(
            await enhancePrompt("improve this", { accountContext: { kind: "legacy", providerID: "openai" } }),
          ).toBe("rewritten")

          expect(profiles).toEqual([a.id, b.id, undefined])
          expect(identities.map((identity) => identity.sourceSessionID)).toEqual([source.id, undefined, undefined])
          expect(identities.map((identity) => identity.mode)).toEqual(["profile", "profile", "legacy"])
          expect(identities.map((identity) => identity.profileID)).toEqual([a.id, b.id, undefined])
          expect(new Set(identities.map((identity) => identity.id)).size).toBe(3)
          expect(identities[0]?.id).not.toBe(source.id)
          expect(requests.map((request) => request.system)).toEqual([undefined, undefined, INSTRUCTION])
          expect(requests.slice(0, 2).every((request) => request.providerOptions?.openai?.store === false)).toBe(true)
          expect(
            requests.slice(0, 2).every((request) => request.providerOptions?.openai?.instructions === INSTRUCTION),
          ).toBe(true)
          expect(models).toEqual([undefined, "selected-enhancement-model", undefined, undefined, undefined])
          expect(JSON.stringify(requests)).not.toContain("POISON_")
          expect(await AppRuntime.runPromise(Session.Service.use((sessions) => sessions.list()))).toHaveLength(
            list.length,
          )
          expect(await prepareEnhancePrompt()).toMatchObject({
            profilesEnabled: true,
            requiresAccountContext: true,
            allowedContextKinds: ["legacy", "account", "session"],
          })

          const count = requests.length
          await expect(enhancePrompt("missing context")).rejects.toMatchObject({
            name: "UtilityAccountError",
            code: "selection-required",
          })
          expect(requests).toHaveLength(count)
          await expect(
            enhancePrompt("missing account", {
              accountContext: {
                kind: "account",
                providerID: "openai",
                authMode: "chatgpt-oauth",
                accountID: "missing-profile",
              },
            }),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "account-unavailable" })
          await expect(
            enhancePrompt("missing source", {
              accountContext: { kind: "session", sourceSessionID: "ses_missing_source" },
            }),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "source-unavailable" })
          await service(ProviderAccountProfiles.Service.use((store) => store.clearDefault("openai", "chatgpt-oauth")))
          const unbound = await AppRuntime.runPromise(Session.Service.use((sessions) => sessions.create({})))
          await expect(
            enhancePrompt("unbound source", { accountContext: { kind: "session", sourceSessionID: unbound.id } }),
          ).rejects.toMatchObject({ name: "UtilityAccountError", code: "source-unbound" })
          expect(requests).toHaveLength(count)

          process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
          await enhancePrompt("legacy compatibility")
          expect(profiles.at(-1)).toBeUndefined()
          expect(requests.at(-1)?.system).toBe(INSTRUCTION)

          const prepared = await prepareEnhancePrompt()
          expect(prepared.allowedContextKinds).toEqual(["legacy", "session"])
          expect(prepared.requiresAccountContext).toBe(false)

          process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
          modelSpy.mockImplementation(async (selected) => {
            models.push(selected?.modelID)
            return {
              model: ProviderTest.model({
                providerID: ProviderV2.ID.make("anthropic"),
                id: ModelV2.ID.make("claude-prepared"),
              }),
            }
          })
          expect(await prepareEnhancePrompt()).toMatchObject({
            profilesEnabled: true,
            requiresAccountContext: false,
            allowedContextKinds: ["legacy", "session"],
          })
        } finally {
          modelSpy.mockRestore()
          authority.mockRestore()
          lang.mockRestore()
          generate.mockRestore()
          await service(ProviderAccountProfiles.Service.use((store) => store.remove(a.id)))
          await service(ProviderAccountProfiles.Service.use((store) => store.remove(b.id)))
        }
      },
    })
  })
})
