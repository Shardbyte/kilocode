import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppRuntime } from "../../src/effect/app-runtime"
import { provide as provideInstance } from "../../src/kilocode/instance"
import {
  CommitMessageRuntime,
  generateCommitMessage,
  prepareCommitMessage,
} from "../../src/kilocode/commit-message/generate"
import { Session } from "../../src/session/session"
import type { LLM } from "../../src/session/llm"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"

const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const api = process.env.OPENAI_API_KEY
const mdl = ProviderTest.model({
  id: ModelV2.ID.make("gpt-utility-generation-test"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-utility-generation-test", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
})

afterEach(() => {
  if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
  if (api === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = api
})

const service = <A, E>(effect: Effect.Effect<A, E, ProviderAccountProfiles.Service>) => AppRuntime.runPromise(effect)

describe("commit-message generation authority", () => {
  test("uses explicit frozen account/model identities and rejects absent authority before transport", async () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    process.env.OPENAI_API_KEY = "POISON_ENV_API_KEY"
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/note.txt`, "changes")

    await provideInstance({
      directory: tmp.path,
      fn: async () => {
        const a = await service(
          ProviderAccountProfiles.Service.use((store) =>
            store.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Commit A",
              remoteID: "commit-a",
              credential: {
                access: "POISON_PROFILE_A_ACCESS",
                refresh: "POISON_PROFILE_A_REFRESH",
                expires: Date.now() + 60_000,
              },
            }),
          ),
        )
        const b = await service(
          ProviderAccountProfiles.Service.use((store) =>
            store.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Commit B",
              remoteID: "commit-b",
              credential: {
                access: "POISON_PROFILE_B_ACCESS",
                refresh: "POISON_PROFILE_B_REFRESH",
                expires: Date.now() + 60_000,
              },
            }),
          ),
        )
        const before = await AppRuntime.runPromise(Session.Service.use((sessions) => sessions.list()))
        const selected: Array<string | undefined> = []
        const requests: Array<LLM.StreamInput> = []
        const gate = Promise.withResolvers<void>()
        const entered = Promise.withResolvers<void>()
        const model = spyOn(CommitMessageRuntime, "model").mockImplementation(async (ref) => {
          selected.push(ref?.modelID)
          return ProviderTest.model({ ...mdl, id: ModelV2.ID.make(ref?.modelID ?? mdl.id) })
        })
        const generate = spyOn(CommitMessageRuntime, "generate").mockImplementation(async (input) => {
          requests.push(input)
          entered.resolve()
          await gate.promise
          return "feat: generated safely"
        })

        try {
          const first = generateCommitMessage({
            path: tmp.path,
            model: { providerID: "openai", modelID: "pinned-model-a" },
            accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: a.id },
          })
          await entered.promise
          await service(
            ProviderAccountProfiles.Service.use((store) => store.selectDefault("openai", "chatgpt-oauth", b.id)),
          )
          gate.resolve()
          expect(await first).toEqual({ message: "feat: generated safely" })

          gate.resolve()
          const second = await generateCommitMessage({
            path: tmp.path,
            model: { providerID: "openai", modelID: "pinned-model-b" },
            accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: b.id },
          })
          expect(second.message).toBe("feat: generated safely")
          await generateCommitMessage({
            path: tmp.path,
            model: { providerID: "openai", modelID: "legacy-opt-in" },
            accountContext: { kind: "legacy", providerID: "openai" },
          })

          expect(selected).toEqual(["pinned-model-a", "pinned-model-b", "legacy-opt-in"])
          expect(
            requests.map((item) =>
              item.utilityAccount?.mode === "profile" ? item.utilityAccount.profileID : undefined,
            ),
          ).toEqual([a.id, b.id, undefined])
          expect(requests.map((item) => item.model.id)).toEqual([
            ModelV2.ID.make("pinned-model-a"),
            ModelV2.ID.make("pinned-model-b"),
            ModelV2.ID.make("legacy-opt-in"),
          ])
          expect(requests.at(-1)?.utilityAccount?.mode).toBe("legacy")
          expect(new Set(requests.map((item) => item.sessionID)).size).toBe(3)
          expect(requests.every((item) => item.small === false)).toBe(true)
          expect(JSON.stringify(requests)).not.toContain("POISON_")
          expect(await AppRuntime.runPromise(Session.Service.use((sessions) => sessions.list()))).toHaveLength(
            before.length,
          )
          expect(await prepareCommitMessage()).toEqual({
            model: { providerID: ProviderV2.ID.openai, modelID: mdl.id },
            profilesEnabled: true,
            requiresAccountContext: true,
            allowedContextKinds: ["legacy", "account"],
          })

          const count = requests.length
          await expect(
            generateCommitMessage({ path: tmp.path, model: { providerID: "openai", modelID: "pinned-model-a" } }),
          ).rejects.toMatchObject({
            name: "UtilityAccountError",
            code: "selection-required",
          })
          expect(requests).toHaveLength(count)

          process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
          await generateCommitMessage({ path: tmp.path, model: { providerID: "openai", modelID: "legacy-model" } })
          expect(requests.at(-1)?.utilityAccount?.mode).toBe("legacy")
          expect((await prepareCommitMessage()).allowedContextKinds).toEqual(["legacy"])
          model.mockImplementation(async () =>
            ProviderTest.model({ providerID: ProviderV2.ID.make("anthropic"), id: ModelV2.ID.make("claude-test") }),
          )
          expect(await prepareCommitMessage()).toMatchObject({
            profilesEnabled: false,
            requiresAccountContext: false,
            allowedContextKinds: ["legacy"],
          })
        } finally {
          gate.resolve()
          generate.mockRestore()
          model.mockRestore()
          await service(ProviderAccountProfiles.Service.use((store) => store.remove(a.id)))
          await service(ProviderAccountProfiles.Service.use((store) => store.remove(b.id)))
        }
      },
    })
  })
})
