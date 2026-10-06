import { afterEach, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Server } from "../../../src/server/server"
import { CommitMessageRuntime } from "../../../src/kilocode/commit-message/generate"
import { EnhancePromptRuntime } from "../../../src/kilocode/enhance-prompt"
import { provide as provideInstance } from "../../../src/kilocode/instance"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

const prior = {
  profiles: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES,
  api: process.env.OPENAI_API_KEY,
}
const model = {
  providerID: ProviderV2.ID.openai,
  id: ModelV2.ID.make("gpt-old-client-protocol"),
  api: { id: "gpt-old-client-protocol", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  capabilities: { temperature: true },
  options: {},
}

afterEach(async () => {
  if (prior.profiles === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.profiles
  if (prior.api === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = prior.api
  await disposeAllInstances()
  await resetDatabase()
})

test("published old VS Code commit payload is rejected without context when enabled and resolves legacy when disabled", async () => {
  await using tmp = await tmpdir({ git: true })
  await Bun.write(`${tmp.path}/note.txt`, "old VS Code client protocol")
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  const selected = spyOn(CommitMessageRuntime, "model").mockResolvedValue(model as never)
  const generated = spyOn(CommitMessageRuntime, "generate").mockImplementation(
    async (input) => `authority=${input.utilityAccount?.mode}`,
  )
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })

  try {
    const account = await provideInstance({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: "Old VS Code default",
              credential: { access: "OLD_CLIENT_ACCESS", refresh: "OLD_CLIENT_REFRESH", expires: Date.now() + 60_000 },
            }),
          ),
        ),
    })
    await provideInstance({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          ProviderAccountProfiles.Service.use((profiles) =>
            profiles.selectDefault("openai", "chatgpt-oauth", account.id),
          ),
        ),
    })

    // Serialized shape of the pre-prepare VS Code client call: its undefined optional
    // selectedFiles/previousMessage keys are omitted, and it has no model or accountContext.
    const payload = { path: tmp.path, language: "en" }
    const enabled = await fetch(new URL("/commit-message", listener.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
      body: JSON.stringify(payload),
    })
    expect(enabled.status).toBe(422)
    expect(await enabled.json()).toMatchObject({
      message: "Select an account or explicitly choose legacy provider authentication for this generation",
    })
    expect(generated).not.toHaveBeenCalled()
    expect(selected).toHaveBeenCalledTimes(1)

    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
    const disabled = await fetch(new URL("/commit-message", listener.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
      body: JSON.stringify(payload),
    })
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({ message: "authority=legacy" })
    expect(generated).toHaveBeenCalledTimes(1)
  } finally {
    await listener.stop(true)
    generated.mockRestore()
    selected.mockRestore()
  }
})

test("published old JetBrains enhancement payload is rejected without context when enabled and resolves legacy when disabled", async () => {
  await using tmp = await tmpdir({ git: true })
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  const selected = spyOn(EnhancePromptRuntime, "model").mockResolvedValue({ model: model as never })
  const language = spyOn(EnhancePromptRuntime, "language").mockResolvedValue({} as never)
  const generated = spyOn(EnhancePromptRuntime, "generate").mockResolvedValue({ text: "rewritten" } as never)
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })

  try {
    // This is the historical JetBrains client's exact request body: text only.
    const payload = { text: "draft prompt" }
    const enabled = await fetch(new URL("/enhance-prompt", listener.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
      body: JSON.stringify(payload),
    })
    expect(enabled.status).toBe(422)
    expect(await enabled.json()).toMatchObject({
      message: "Select an account or explicitly choose legacy provider authentication for this generation",
    })
    expect(language).not.toHaveBeenCalled()
    expect(generated).not.toHaveBeenCalled()
    expect(selected).toHaveBeenCalledTimes(1)

    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
    const disabled = await fetch(new URL("/enhance-prompt", listener.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
      body: JSON.stringify(payload),
    })
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({ text: "rewritten" })
    expect(language).toHaveBeenCalledTimes(1)
    expect(generated).toHaveBeenCalledTimes(1)
  } finally {
    await listener.stop(true)
    generated.mockRestore()
    language.mockRestore()
    selected.mockRestore()
  }
})

test("standalone HTTP utilities reject credential and authority smuggling before model acquisition", async () => {
  await using tmp = await tmpdir({ git: true })
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  const marker = "SECRET_HTTP_UTILITY_AUTHORITY"
  const context = { kind: "legacy", providerID: "openai" }
  const commit = spyOn(CommitMessageRuntime, "model")
  const enhance = spyOn(EnhancePromptRuntime, "model")
  const generation = spyOn(CommitMessageRuntime, "generate")
  const rewrite = spyOn(EnhancePromptRuntime, "generate")
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    for (const route of ["commit-message", "enhance-prompt"]) {
      const base = route === "commit-message" ? { path: tmp.path } : { text: "intentional draft" }
      const payloads = [
        { ...base, accountContext: context, credential: { access: marker, refresh: marker } },
        { ...base, accountContext: context, headers: { authorization: marker } },
        { ...base, accountContext: { ...context, apiKey: marker } },
        { ...base, accountContext: { ...context, headers: { authorization: marker } } },
        { ...base, accountContext: { ...context, sourceSessionID: marker } },
        { ...base, accountContext: { ...context, accountID: marker } },
        { ...base, accountContext: context, model: { providerID: "openai", modelID: "gpt-5", apiKey: marker } },
      ]
      for (const payload of payloads) {
        const response = await fetch(new URL(`/${route}`, listener.url), {
          method: "POST",
          headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
          body: JSON.stringify(payload),
        })
        expect(response.status).toBe(400)
        // Rejected caller input may appear in schema diagnostics; it must never become authority.
        expect(await response.json()).toMatchObject({ name: "BadRequest", data: { kind: "Payload" } })
      }
    }
    expect(commit).not.toHaveBeenCalled()
    expect(enhance).not.toHaveBeenCalled()
    expect(generation).not.toHaveBeenCalled()
    expect(rewrite).not.toHaveBeenCalled()
  } finally {
    await listener.stop(true)
    commit.mockRestore()
    enhance.mockRestore()
    generation.mockRestore()
    rewrite.mockRestore()
  }
})
