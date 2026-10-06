import { afterEach, expect, spyOn, test } from "bun:test"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { EnhancePromptRuntime, enhancePrompt, prepareEnhancePrompt } from "@/kilocode/enhance-prompt"
import { ProviderTest } from "../../fake/provider"
import { testEffect } from "../../lib/effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES

afterEach(() => {
  if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
})

const it = testEffect(LayerNode.compile(ProviderAccountProfiles.node))

const profile = Effect.fn("Adversarial.profile")(function* (label: string) {
  const profiles = yield* ProviderAccountProfiles.Service
  return yield* profiles.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label,
    remoteID: `remote-${label}`,
    credential: {
      access: `M10_ACCESS_${label}`,
      refresh: `M10_REFRESH_${label}`,
      expires: Date.now() + 60_000,
      accountID: `remote-${label}`,
    },
  })
})

test("prepared enhancement model resists a later default mutation", async () => {
  const base = ProviderTest.model({
    id: ModelV2.ID.make("gpt-5-mini"),
    providerID: ProviderV2.ID.openai,
    api: { id: "gpt-5-mini", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  })
  let current = "gpt-5-mini"
  const refs: Array<string | undefined> = []
  const select = spyOn(EnhancePromptRuntime, "model").mockImplementation(async (ref) => {
    refs.push(ref?.modelID)
    return { model: ProviderTest.model({ ...base, id: ModelV2.ID.make(ref?.modelID ?? current) }) }
  })
  const authority = spyOn(EnhancePromptRuntime, "authority").mockResolvedValue({
    id: "utility-qualification",
    operation: "enhance-prompt",
    directory: "/tmp/qualification",
    providerID: "openai",
    modelID: base.id,
    mode: "profile",
    profileID: "account-A",
  })
  const used: string[] = []
  const language = spyOn(EnhancePromptRuntime, "language").mockImplementation(async (model, profileID) => {
    used.push(`${model.id}:${profileID}`)
    return {} as never
  })
  const generate = spyOn(EnhancePromptRuntime, "generate").mockResolvedValue({ text: "rewritten" } as never)
  try {
    const prepared = await prepareEnhancePrompt()
    expect(String(prepared.model.providerID)).toBe("openai")
    expect(String(prepared.model.modelID)).toBe("gpt-5-mini")
    current = "gpt-4.1"
    await EnhancePromptRuntime.model()
    expect(
      await enhancePrompt("draft", {
        model: prepared.model,
        accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "account-A" },
      }),
    ).toBe("rewritten")
    expect(refs).toEqual([undefined, undefined, "gpt-5-mini"])
    expect(used).toEqual(["gpt-5-mini:account-A"])
    expect(authority).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
  } finally {
    select.mockRestore()
    authority.mockRestore()
    language.mockRestore()
    generate.mockRestore()
  }
})

it.instance("overlapping A/B profile transports keep separate identities", () =>
  Effect.gen(function* () {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const a = yield* profile("normal-A")
    const b = yield* profile("utility-B")
    const profiles = yield* ProviderAccountProfiles.Service
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const wire: Array<{ access: string; revision: number }> = []
    const first = yield* profiles.dispatch(a.id, async (credential, revision) => {
      wire.push({ access: credential.access, revision })
      entered.resolve()
      await gate.promise
      return "A"
    })
    yield* Effect.promise(() => entered.promise)
    const second = yield* profiles.dispatch(b.id, async (credential, revision) => {
      wire.push({ access: credential.access, revision })
      return "B"
    })
    expect(wire).toEqual([
      { access: "M10_ACCESS_normal-A", revision: 0 },
      { access: "M10_ACCESS_utility-B", revision: 0 },
    ])
    gate.resolve()
    expect(yield* Effect.promise(() => first.response)).toBe("A")
    expect(yield* Effect.promise(() => second.response)).toBe("B")
  }),
)

it.instance("deletion after transport handoff permits only the already-started request", () =>
  Effect.gen(function* () {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const acct = yield* profile("handoff")
    const profiles = yield* ProviderAccountProfiles.Service
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const wire: string[] = []
    const dispatched = yield* profiles.dispatch(acct.id, (credential) => {
      wire.push(credential.access)
      entered.resolve()
      return gate.promise.then(() => "finished")
    })
    yield* Effect.promise(() => entered.promise)
    yield* profiles.remove(acct.id)
    gate.resolve()
    expect(yield* Effect.promise(() => dispatched.response)).toBe("finished")
    expect((yield* Effect.exit(profiles.dispatch(acct.id, async () => "unexpected")))._tag).toBe("Failure")
    expect(wire).toEqual(["M10_ACCESS_handoff"])
  }),
)
