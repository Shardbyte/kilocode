import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Server } from "../../../src/server/server"
import { CommitMessageRuntime } from "../../../src/kilocode/commit-message/generate"
import { EnhancePromptRuntime } from "../../../src/kilocode/enhance-prompt"
import { ModelV2 } from "@opencode-ai/core/model"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("commit-message httpapi", () => {
  test("prepares without a body and returns only the current model/context capabilities", async () => {
    await using tmp = await tmpdir({ git: true })
    const model = spyOn(CommitMessageRuntime, "model").mockResolvedValue({
      providerID: "test",
      id: "prepare-model",
    } as never)
    try {
      const res = await Server.Default().app.request("/commit-message/prepare", {
        method: "POST",
        headers: { "x-kilo-directory": tmp.path },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        model: { providerID: "test", modelID: "prepare-model" },
        profilesEnabled: expect.any(Boolean),
        requiresAccountContext: false,
        allowedContextKinds: ["legacy"],
      })
    } finally {
      model.mockRestore()
    }
  })

  test("pins explicit model and context, rejects credential fields, and hides model errors", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "note.txt"), "hello")

    const selected: string[] = []
    const inputs: Array<Parameters<typeof CommitMessageRuntime.generate>[0]> = []
    const model = spyOn(CommitMessageRuntime, "model").mockImplementation(async (ref) => {
      selected.push(ref?.modelID ?? "default")
      if (ref?.modelID === "unavailable") throw new Error("SYNTHETIC_PROVIDER_SECRET")
      return { providerID: "test", id: ref?.modelID ?? "test-model" } as never
    })
    const generate = spyOn(CommitMessageRuntime, "generate").mockImplementation(async (input) => {
      inputs.push(input)
      return "feat: generated safely"
    })
    try {
      const res = await Server.Default().app.request("/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({
          path: tmp.path,
          model: { providerID: "test", modelID: "pinned-model" },
          accountContext: { kind: "legacy", providerID: "test" },
        }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: "feat: generated safely" })
      expect(selected).toEqual(["pinned-model"])
      expect(inputs[0]?.model.id).toBe(ModelV2.ID.make("pinned-model"))
      expect(inputs[0]?.utilityAccount?.mode).toBe("outside")
      const identity = inputs[0]?.utilityAccount
      if (!identity) throw new Error("Expected a resolved utility identity")
      expect(inputs[0]?.sessionID).toBe(identity.id)

      const bad = await Server.Default().app.request("/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({
          path: tmp.path,
          model: { providerID: "test", modelID: "pinned-model" },
          accessToken: "secret",
        }),
      })
      expect(bad.status).toBe(400)
      expect(selected).toEqual(["pinned-model"])
      expect(inputs).toHaveLength(1)

      const unavailable = await Server.Default().app.request("/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({ path: tmp.path, model: { providerID: "test", modelID: "unavailable" } }),
      })
      expect(unavailable.status).toBe(422)
      expect(JSON.stringify(await unavailable.json())).not.toContain("SYNTHETIC_PROVIDER_SECRET")
      expect(inputs).toHaveLength(1)
    } finally {
      generate.mockRestore()
      model.mockRestore()
    }
  })

  test("enhancement prepare/generate APIs use no-body prepare, narrow context, and sanitized failures", async () => {
    await using tmp = await tmpdir({ git: true })
    const selected: Array<string | undefined> = []
    const model = spyOn(EnhancePromptRuntime, "model").mockImplementation(async (ref) => {
      selected.push(ref?.modelID)
      if (ref?.modelID === "unavailable") throw new Error("SYNTHETIC_ENHANCE_SECRET")
      return {
        model: {
          providerID: "test",
          id: ref?.modelID ?? "enhance-model",
          api: { id: ref?.modelID ?? "enhance-model", npm: "@ai-sdk/openai-compatible", url: "" },
          capabilities: { temperature: true },
          options: {},
        },
      } as never
    })
    const language = spyOn(EnhancePromptRuntime, "language").mockResolvedValue({} as never)
    const generate = spyOn(EnhancePromptRuntime, "generate").mockResolvedValue({ text: "rewritten" } as never)
    try {
      const prepared = await Server.Default().app.request("/enhance-prompt/prepare", {
        method: "POST",
        headers: { "x-kilo-directory": tmp.path },
      })
      expect(prepared.status).toBe(200)
      expect(await prepared.json()).toEqual({
        model: { providerID: "test", modelID: "enhance-model" },
        profilesEnabled: expect.any(Boolean),
        requiresAccountContext: false,
        allowedContextKinds: ["legacy", "session"],
      })

      const res = await Server.Default().app.request("/enhance-prompt", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({
          text: "draft",
          model: { providerID: "test", modelID: "selected-enhance-model" },
          accountContext: { kind: "legacy", providerID: "test" },
        }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ text: "rewritten" })
      expect(selected).toEqual([undefined, "selected-enhance-model"])
      expect(language).toHaveBeenCalledWith(expect.objectContaining({ id: "selected-enhance-model" }), undefined)
      expect(generate).toHaveBeenCalledTimes(1)

      const invalid = await Server.Default().app.request("/enhance-prompt", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({
          text: "draft",
          accountContext: { kind: "legacy", providerID: "test", apiKey: "secret" },
        }),
      })
      expect(invalid.status).toBe(400)
      expect(generate).toHaveBeenCalledTimes(1)

      const unavailable = await Server.Default().app.request("/enhance-prompt", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({ text: "draft", model: { providerID: "test", modelID: "unavailable" } }),
      })
      expect(unavailable.status).toBe(422)
      expect(JSON.stringify(await unavailable.json())).not.toContain("SYNTHETIC_ENHANCE_SECRET")
      expect(generate).toHaveBeenCalledTimes(1)
    } finally {
      generate.mockRestore()
      language.mockRestore()
      model.mockRestore()
    }
  })

  test("returns 422 with the real message when there are no changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const model = spyOn(CommitMessageRuntime, "model").mockResolvedValue({
      providerID: "test",
      id: "test-model",
    } as never)
    try {
      const res = await Server.Default().app.request("/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({ path: tmp.path }),
      })

      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ message: "No changes found to generate a commit message for" })
    } finally {
      model.mockRestore()
    }
  })

  test("returns a sanitized error when generation fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "note.txt"), "hello")

    const model = spyOn(CommitMessageRuntime, "model").mockResolvedValue({
      providerID: "test",
      id: "test-small-model",
    } as never)
    const generate = spyOn(CommitMessageRuntime, "generate").mockRejectedValue(new Error("provider rate limited"))
    try {
      const res = await Server.Default().app.request("/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({ path: tmp.path }),
      })

      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ message: "Failed to generate commit message" })
    } finally {
      generate.mockRestore()
      model.mockRestore()
    }
  })

  test("sanitizes context-limit messages from streamed provider errors", async () => {
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const error = {
          code: "context_length_exceeded",
          message: "request exceeds the available context size (4096 tokens): SYNTHETIC_CONTEXT_SECRET",
          type: "exceed_context_size_error",
        }
        return new Response(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "test/small",
          small_model: "test/small",
          enabled_providers: ["test"],
          provider: {
            test: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `${provider.url.origin}/v1`, apiKey: "test-key" },
              models: { small: { name: "Small", limit: { context: 4096, output: 1024 } } },
            },
          },
        },
      })
      await Bun.write(path.join(tmp.path, "note.txt"), "hello")

      const res = await Server.Default().app.request("/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        body: JSON.stringify({ path: tmp.path }),
      })

      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body).toEqual({ message: "Failed to generate commit message" })
      expect(JSON.stringify(body)).not.toContain("SYNTHETIC_CONTEXT_SECRET")
      expect(JSON.stringify(body)).not.toContain("request exceeds the available context size")
    } finally {
      await provider.stop(true)
    }
  })
})
