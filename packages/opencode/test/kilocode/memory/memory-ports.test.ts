import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { APICallError } from "ai"
import { Effect } from "effect"
import { ModelNotFoundError, type Provider } from "../../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import type { Session } from "../../../src/session/session"
import type { SessionSummary } from "../../../src/session/summary"
import type { Snapshot } from "../../../src/snapshot"
import { MemoryModel, MemorySession } from "../../../src/kilocode/memory/ports"
import type { UtilityAccount } from "../../../src/kilocode/provider/utility-account"
import { MemoryTurn } from "../../../src/kilocode/memory/turn"
import { installMemoryRuntime } from "../../../src/kilocode/memory/runtime"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { KiloMemory } from "@kilocode/kilo-memory/effect"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { Global } from "@opencode-ai/core/global"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Session as SessionModule } from "../../../src/session/session"
import path from "path"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"

const pid = ProviderV2.ID.make("test")
const mid = ModelV2.ID.make("fake-memory-model")

function mdl(id = mid, npm = "test-provider", providerID = pid): Provider.Model {
  return {
    id,
    providerID,
    api: { id, npm, url: "" },
    limit: { context: 100_000, output: 4_000 },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
  } as unknown as Provider.Model
}

function lang(outputs: (string | Error)[] = ["{}"], calls?: unknown[], hang?: boolean): LanguageModelV3 {
  let idx = 0
  const next = () => {
    const item = outputs[idx++] ?? outputs.at(-1) ?? "{}"
    if (item instanceof Error) throw item
    return item
  }
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "fake-memory-model",
    supportedUrls: {},
    doGenerate: async (...args: Parameters<LanguageModelV3["doGenerate"]>) => {
      calls?.push(args[0])
      if (hang) return new Promise(() => {})
      const text = next()
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 12 },
          outputTokens: { total: 8 },
          raw: {},
        },
        warnings: [],
        providerMetadata: {},
        request: {},
        response: {},
      }
    },
    doStream: async (...args: Parameters<LanguageModelV3["doStream"]>) => {
      calls?.push(args[0])
      const text = next()
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "text-start", id: "memory" })
            controller.enqueue({ type: "text-delta", id: "memory", delta: text })
            controller.enqueue({ type: "text-end", id: "memory" })
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop" },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            })
            controller.close()
          },
        }),
        request: {},
      }
    },
  } as unknown as LanguageModelV3
}

function provider(
  input: {
    outputs?: (string | Error)[]
    seen?: string[]
    calls?: unknown[]
    hang?: boolean
    npm?: string
    providerID?: ProviderV2.ID
    broken?: Effect.Effect<never, ModelNotFoundError>
  } = {},
): Provider.Interface {
  const providerID = input.providerID ?? pid
  const base = mdl(mid, input.npm, providerID)
  const mem = mdl(ModelV2.ID.make("memory-config-model"), input.npm, providerID)
  const info = {
    id: providerID,
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { [base.id]: base, [mem.id]: mem },
  } satisfies Provider.Info
  return {
    list: () => Effect.succeed({ [providerID]: info }),
    getProvider: () => Effect.succeed(info),
    getModel: (providerID, modelID) => {
      const found = info.models[modelID]
      if (found) return Effect.succeed(found)
      return Effect.fail(new ModelNotFoundError({ providerID, modelID }))
    },
    getLanguage: (model) => {
      input.seen?.push(model.id)
      if (input.broken && model.id === mem.id) return input.broken
      return Effect.succeed(lang(input.outputs, input.calls, input.hang))
    },
    closest: () => Effect.succeed({ providerID: pid, modelID: base.id }),
    getSmallModel: () => Effect.succeed(mem),
    defaultModel: () => Effect.succeed({ providerID: pid, modelID: base.id }),
  }
}

function authority(model: Provider.Model, sessionID: string): Promise<UtilityAccount.Identity> {
  return Promise.resolve(
    Object.freeze({
      id: `test:${sessionID}`,
      operation: "memory",
      directory: "/test",
      providerID: model.providerID,
      modelID: model.id,
      sourceSessionID: sessionID,
      mode: "outside",
    }),
  )
}

function text(sessionID: SessionID, messageID: MessageID, body: string): MessageV2.TextPart {
  return {
    id: PartID.make(`prt_${messageID}_text`),
    sessionID,
    messageID,
    type: "text",
    text: body,
  }
}

function tool(input: {
  sessionID: SessionID
  messageID: MessageID
  name: string
  command?: string
  meta?: Record<string, unknown>
}): MessageV2.ToolPart {
  return {
    id: PartID.make(`prt_${input.messageID}_tool`),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: `call_${input.messageID}`,
    tool: input.name,
    state: {
      status: "completed",
      input: input.command ? { command: input.command } : {},
      output: "",
      title: input.name,
      metadata: input.meta ?? {},
      time: { start: 1, end: 2 },
    },
  }
}

function user(input: { sessionID: SessionID; id: MessageID; body: string }): MessageV2.WithParts {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: "user",
      time: { created: 1 },
      agent: "code",
      model: { providerID: pid, modelID: mid },
    },
    parts: [text(input.sessionID, input.id, input.body)],
  }
}

function assistant(input: {
  sessionID: SessionID
  id: MessageID
  parentID: MessageID
  parts: MessageV2.Part[]
  time: number
  finish?: string
}): MessageV2.WithParts {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: "assistant",
      time: { created: input.time, completed: input.time + 1 },
      parentID: input.parentID,
      modelID: mid,
      providerID: pid,
      mode: "build",
      agent: "code",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: input.finish ?? "stop",
    },
    parts: input.parts,
  }
}

function sessions(messages: MessageV2.WithParts[]): Session.Interface {
  return {
    get: () => Effect.succeed({ parentID: undefined }),
    messages: (input?: { limit?: number }) => Effect.succeed(input?.limit ? messages.slice(-input.limit) : messages),
  } as unknown as Session.Interface
}

function summary(input: { seen: string[]; diffs: Snapshot.FileDiff[] }): SessionSummary.Interface {
  return {
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: (current: { messages: MessageV2.WithParts[] }) => {
      input.seen.push(...current.messages.map((item) => item.info.id))
      return Effect.succeed(input.diffs)
    },
  } as SessionSummary.Interface
}

const ref = { providerID: "test", modelID: "fake-memory-model" }

describe("memory ports", () => {
  test("session port extracts the latest turn, recall markers, and all assistant steps", async () => {
    const sessionID = SessionID.make("ses_memory_adapter")
    const uid = MessageID.make("msg_user")
    const recall = MessageID.make("msg_recall")
    const shell = MessageID.make("msg_shell")
    const final = MessageID.make("msg_final")
    const diffs = [
      {
        file: "packages/opencode/src/kilocode/memory/ports.ts",
        additions: 4,
        deletions: 1,
        status: "modified" as const,
      },
    ] satisfies Snapshot.FileDiff[]
    const seen: string[] = []
    const messages = [
      user({
        sessionID,
        id: uid,
        body: "remember the package test command with OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      }),
      assistant({
        sessionID,
        id: recall,
        parentID: uid,
        time: 2,
        finish: "tool-calls",
        parts: [
          tool({
            sessionID,
            messageID: recall,
            name: "kilo_memory_recall",
            meta: { count: 2, bytes: 120, tokens: 30, files: ["project.md"] },
          }),
        ],
      }),
      assistant({
        sessionID,
        id: shell,
        parentID: uid,
        time: 4,
        finish: "tool-calls",
        parts: [
          tool({
            sessionID,
            messageID: shell,
            name: "bash",
            command: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 bun test",
          }),
        ],
      }),
      assistant({
        sessionID,
        id: final,
        parentID: uid,
        time: 6,
        parts: [text(sessionID, final, "Run bun test from packages/opencode for CLI memory tests.")],
      }),
    ]

    const view = await Effect.runPromise(
      MemorySession.port({ sessions: sessions(messages), summary: summary({ seen, diffs }) }).readTurn({
        sessionID,
        window: 24,
      }),
    )

    expect(view).toMatchObject({
      user: "remember the package test command with [redacted]",
      assistant: "Run bun test from packages/opencode for CLI memory tests.",
      lastAssistantID: final,
      sessionModel: ref,
      recalledMemory: true,
      diffs,
    })
    expect(view?.recent).toContain("Tool kilo_memory_recall completed")
    expect(view?.recent).toContain("command=[redacted]")
    expect(view?.recent).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
    expect(view?.user).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
    expect(seen).toEqual([uid, recall, shell, final])
  })

  test("model port resolves configured models and falls back to the session model", async () => {
    const seen: string[] = []
    const port = MemoryModel.port({ provider: provider({ seen }), authority })

    const configured = await Effect.runPromise(port.resolve({ configured: "test/memory-config-model", session: ref }))
    const fallback = await Effect.runPromise(port.resolve({ configured: "test/missing-memory-model", session: ref }))
    const invalid = await Effect.runPromise(port.resolve({ configured: "memory-config-model", session: ref }))

    expect(configured.fallback).toBeUndefined()
    expect(fallback.fallback).toEqual({ reason: "model unavailable" })
    expect(invalid.fallback).toEqual({ reason: "invalid model" })
    expect(seen).toEqual([])
  })

  test("known catalog fallback cannot fall back again when the session language is missing", async () => {
    const seen: string[] = []
    const auth: string[] = []
    const port = MemoryModel.port({
      provider: {
        ...provider({}),
        getLanguage: (model) => {
          seen.push(model.id)
          return Effect.fail(new ModelNotFoundError({ providerID: pid, modelID: model.id }))
        },
      },
      authority: async (model, sessionID) => {
        auth.push(`${sessionID}:${model.id}`)
        return authority(model, sessionID)
      },
    })
    const result = await Effect.runPromise(port.resolve({ configured: "test/missing-memory-model", session: ref }))

    expect(result.fallback).toEqual({ reason: "model unavailable" })
    await expect(
      port.run({
        handle: result.handle,
        sessionID: "ses_catalog_fallback",
        system: "system",
        prompt: "prompt",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("Memory utility generation failed")
    expect(seen).toEqual(["fake-memory-model"])
    expect(auth).toEqual(["ses_catalog_fallback:fake-memory-model"])
  })

  test("model port resolves authority from the real source session before language acquisition", async () => {
    const order: string[] = []
    const port = MemoryModel.port({
      provider: {
        ...provider({ seen: order }),
        getLanguage: (model) => {
          order.push(`language:${model.id}`)
          return Effect.succeed(lang())
        },
      },
      authority: async (model, sessionID) => {
        order.push(`authority:${sessionID}`)
        return authority(model, sessionID)
      },
    })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_source_memory",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    expect(order).toEqual(["authority:ses_source_memory", "language:fake-memory-model"])
  })

  test("authority failure and source-context mismatch fail closed before language acquisition", async () => {
    const seen: string[] = []
    const deniedModels: string[] = []
    const mismatched: string[] = []
    const denied = MemoryModel.port({
      provider: provider({ seen }),
      authority: async (model) => {
        deniedModels.push(model.id)
        throw new Error("authority denied")
      },
    })
    const mismatch = MemoryModel.port({
      provider: provider({ seen }),
      authority: async (model, sessionID) => {
        mismatched.push(model.id)
        return { ...(await authority(model, sessionID)), sourceSessionID: "ses_wrong" }
      },
    })
    const deniedModel = await Effect.runPromise(
      denied.resolve({ configured: "test/memory-config-model", session: ref }),
    )
    const mismatchModel = await Effect.runPromise(
      mismatch.resolve({ configured: "test/memory-config-model", session: ref }),
    )
    const opts = {
      sessionID: "ses_memory_guard",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    }

    await expect(denied.run({ handle: deniedModel.handle, ...opts })).rejects.toThrow(
      "Memory utility generation failed",
    )
    await expect(mismatch.run({ handle: mismatchModel.handle, ...opts })).rejects.toMatchObject({
      name: "UtilityAccountError",
      code: "context-mismatch",
    })
    expect(deniedModel.fallback).toBeUndefined()
    expect(mismatchModel.fallback).toBeUndefined()
    expect(seen).toEqual([])
    expect(deniedModels).toEqual(["memory-config-model"])
    expect(mismatched).toEqual(["memory-config-model"])
  })

  test("configured profile SDK defects do not fall back or use ambient credentials", async () => {
    const seen: string[] = []
    const calls: unknown[] = []
    const auth: string[] = []
    const port = MemoryModel.port({
      provider: {
        ...provider({ npm: "@ai-sdk/openai", providerID: ProviderV2.ID.make("openai"), calls }),
        getLanguage: (model, profileID) => {
          seen.push(`${model.id}:${profileID}`)
          return Effect.die(new Error("profile SDK initialization failed"))
        },
      },
      authority: async (model, sessionID) => {
        auth.push(`${sessionID}:${model.id}`)
        return { ...(await authority(model, sessionID)), mode: "profile", profileID: "selected-profile" }
      },
    })
    const result = await Effect.runPromise(port.resolve({ configured: "openai/memory-config-model", session: ref }))

    await expect(
      port.run({
        handle: result.handle,
        sessionID: "ses_profile_defect",
        system: "retained memory instructions",
        prompt: "prompt",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("Memory utility generation failed")
    expect(seen).toEqual(["memory-config-model:selected-profile"])
    expect(auth).toEqual(["ses_profile_defect:memory-config-model"])
    expect(calls).toEqual([])
  })

  test("configured outside-mode SDK defects fail closed without exposing provider errors", async () => {
    const secret = "provider-secret-detail-must-not-escape"
    const seen: string[] = []
    const port = MemoryModel.port({
      provider: {
        ...provider({}),
        getLanguage: (model) => {
          seen.push(model.id)
          return Effect.die(new Error(secret))
        },
      },
      authority,
    })
    const result = await Effect.runPromise(port.resolve({ configured: "test/memory-config-model", session: ref }))
    const failure = await port
      .run({
        handle: result.handle,
        sessionID: "ses_outside_defect",
        system: "system",
        prompt: "prompt",
        timeoutMs: 30_000,
      })
      .then(
        () => "",
        (err) => String(err),
      )

    expect(failure).toContain("Memory utility generation failed")
    expect(failure).not.toContain(secret)
    expect(seen).toEqual(["memory-config-model"])
  })

  test("profile preparation passes selected profile and preserves no-store instructions", async () => {
    const calls: unknown[] = []
    const port = MemoryModel.port({
      provider: provider({ npm: "@ai-sdk/openai", providerID: ProviderV2.ID.make("openai"), calls }),
      authority: async (model, sessionID) => ({
        ...(await authority(model, sessionID)),
        mode: "profile",
        profileID: "selected-profile",
      }),
    })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_profile_options",
      system: "retained memory instructions",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    const opts = calls[0] as { providerOptions?: Record<string, { store?: boolean; instructions?: string }> }
    expect(opts.providerOptions?.openai).toMatchObject({ store: false, instructions: "retained memory instructions" })
  })

  test("model port defers OpenAI language-model resolution until the source session is available", async () => {
    const seen: string[] = []
    const port = MemoryModel.port({
      provider: provider({ npm: "@ai-sdk/openai", providerID: ProviderV2.ID.make("openai"), seen }),
      authority,
    })

    const result = await Effect.runPromise(
      port.resolve({
        session: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fake-memory-model") },
      }),
    )

    expect((result.handle as { source: Provider.Model }).source.providerID).toBe(ProviderV2.ID.make("openai"))
    expect(seen).toEqual([])
  })

  test("model handle snapshots authority once across consolidation stages", async () => {
    const seen: Array<string | undefined> = []
    let selected = "account-A"
    let reads = 0
    const port = MemoryModel.port({
      provider: {
        ...provider({ npm: "@ai-sdk/openai", providerID: ProviderV2.ID.make("openai") }),
        getLanguage: (_model, profileID) => {
          seen.push(profileID)
          return Effect.succeed(lang())
        },
      },
      authority: async (model, sessionID) => {
        reads++
        return { ...(await authority(model, sessionID)), mode: "profile", profileID: selected }
      },
    })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))
    const input = {
      handle: resolved.handle,
      sessionID: "ses_memory",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    }
    await Promise.all([port.run(input), port.run(input)])
    selected = "account-B"
    await port.run(input)
    expect(reads).toBe(1)
    expect(seen).toEqual(["account-A"])
    await expect(port.run({ ...input, sessionID: "ses_other" })).rejects.toThrow("Memory utility generation failed")
    expect(seen).toHaveLength(1)
  })

  test("concurrent typed fallback stages share one source and profile snapshot", async () => {
    const auth: string[] = []
    const seen: string[] = []
    let profile = "profile-A"
    const port = MemoryModel.port({
      provider: {
        ...provider({ npm: "@ai-sdk/openai", providerID: ProviderV2.ID.make("openai") }),
        getLanguage: (model, profileID) => {
          seen.push(`${model.id}:${profileID}`)
          if (model.id === "memory-config-model")
            return Effect.fail(
              new ModelNotFoundError({
                providerID: ProviderV2.ID.make("openai"),
                modelID: ModelV2.ID.make(model.id),
              }),
            )
          return Effect.succeed(lang())
        },
      },
      authority: async (model, sessionID) => {
        auth.push(`${sessionID}:${model.id}`)
        return { ...(await authority(model, sessionID)), mode: "profile", profileID: profile }
      },
    })
    const resolved = await Effect.runPromise(port.resolve({ configured: "openai/memory-config-model", session: ref }))
    const input = {
      handle: resolved.handle,
      sessionID: "ses_typed_fallback_snapshot",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    }

    await Promise.all([port.run(input), port.run(input)])
    profile = "profile-B"
    await port.run(input)

    expect(auth).toEqual([
      "ses_typed_fallback_snapshot:memory-config-model",
      "ses_typed_fallback_snapshot:fake-memory-model",
    ])
    expect(seen).toEqual(["memory-config-model:profile-A", "fake-memory-model:profile-A"])
  })

  test("typed fallback rejects authority mode or profile changes", async () => {
    for (const change of ["legacy", "outside", "profile-B"] as const) {
      const auth: string[] = []
      const seen: string[] = []
      let reads = 0
      const port = MemoryModel.port({
        provider: {
          ...provider({ npm: "@ai-sdk/openai", providerID: ProviderV2.ID.make("openai") }),
          getLanguage: (model, profileID) => {
            seen.push(`${model.id}:${profileID}`)
            return Effect.fail(
              new ModelNotFoundError({
                providerID: ProviderV2.ID.make("openai"),
                modelID: ModelV2.ID.make(model.id),
              }),
            )
          },
        },
        authority: async (model, sessionID): Promise<UtilityAccount.Identity> => {
          auth.push(`${sessionID}:${model.id}`)
          reads++
          const base = await authority(model, sessionID)
          if (reads === 1) return { ...base, mode: "profile", profileID: "profile-A" }
          if (change === "profile-B") return { ...base, mode: "profile", profileID: "profile-B" }
          return { ...base, mode: change }
        },
      })
      const resolved = await Effect.runPromise(port.resolve({ configured: "openai/memory-config-model", session: ref }))
      const failure = await port
        .run({
          handle: resolved.handle,
          sessionID: `ses_typed_mismatch_${change}`,
          system: "system",
          prompt: "prompt",
          timeoutMs: 30_000,
        })
        .then(
          () => undefined,
          (err) => err,
        )

      expect(failure).toMatchObject({ name: "UtilityAccountError", code: "context-mismatch" })
      expect(auth).toEqual([
        `ses_typed_mismatch_${change}:memory-config-model`,
        `ses_typed_mismatch_${change}:fake-memory-model`,
      ])
      expect(seen).toEqual(["memory-config-model:profile-A"])
    }
  })

  test("model port falls back to the session model when the configured model has no language model", async () => {
    const seen: string[] = []
    const broken = Effect.fail(
      new ModelNotFoundError({ providerID: pid, modelID: ModelV2.ID.make("memory-config-model") }),
    )
    const port = MemoryModel.port({ provider: provider({ seen, broken }), authority })

    const result = await Effect.runPromise(port.resolve({ configured: "test/memory-config-model", session: ref }))

    await port.run({
      handle: result.handle,
      sessionID: "ses_language_fallback",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })
    expect(result.fallback).toBeUndefined()
    expect(seen).toEqual(["memory-config-model", "fake-memory-model"])
  })

  test("model port fails closed when its session-model fallback has no language model", async () => {
    const seen: string[] = []
    const auth: string[] = []
    const port = MemoryModel.port({
      provider: {
        ...provider({}),
        getLanguage: (model) => {
          seen.push(model.id)
          return Effect.fail(new ModelNotFoundError({ providerID: pid, modelID: model.id }))
        },
      },
      authority: async (model, sessionID) => {
        auth.push(`${sessionID}:${model.id}`)
        return authority(model, sessionID)
      },
    })
    const result = await Effect.runPromise(port.resolve({ configured: "test/memory-config-model", session: ref }))

    const input = {
      handle: result.handle,
      sessionID: "ses_missing_session_language",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    }
    const failed = await Promise.all([
      port.run(input).then(
        () => "",
        (err) => String(err),
      ),
      port.run(input).then(
        () => "",
        (err) => String(err),
      ),
    ])
    expect(failed.every((err) => err.includes("Memory utility generation failed"))).toBe(true)
    expect(seen).toEqual(["memory-config-model", "fake-memory-model"])
    expect(auth).toEqual([
      "ses_missing_session_language:memory-config-model",
      "ses_missing_session_language:fake-memory-model",
    ])
  })

  test("model port falls back to the session model when the configured model's SDK fails to load", async () => {
    const seen: string[] = []
    const broken = Effect.die(new Error("sdk failed to load"))
    const port = MemoryModel.port({
      provider: provider({ seen, broken }),
      authority: async (model, sessionID) => ({ ...(await authority(model, sessionID)), mode: "legacy" }),
    })

    const result = await Effect.runPromise(port.resolve({ configured: "test/memory-config-model", session: ref }))

    await port.run({
      handle: result.handle,
      sessionID: "ses_legacy_fallback",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })
    expect(result.fallback).toBeUndefined()
    expect(seen).toEqual(["memory-config-model", "fake-memory-model"])
  })

  test("model port sends x-opencode-session for opencode-managed memory models", async () => {
    const calls: unknown[] = []
    const port = MemoryModel.port({
      provider: provider({ providerID: ProviderV2.ID.make("opencode"), calls }),
      authority,
    })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_memory_headers",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    const opts = calls[0] as { headers?: Record<string, string> }
    expect(opts.headers?.["x-opencode-session"]).toBe("ses_memory_headers")
  })

  test("model port omits opencode headers for non-opencode memory models", async () => {
    const calls: unknown[] = []
    const port = MemoryModel.port({ provider: provider({ calls }), authority })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_memory_headers",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    const opts = calls[0] as { headers?: Record<string, string> }
    expect(opts.headers?.["x-opencode-session"]).toBeUndefined()
  })

  test("model port asks OpenAI-compatible providers for a non-streaming JSON response", async () => {
    const calls: unknown[] = []
    const port = MemoryModel.port({ provider: provider({ npm: "@ai-sdk/openai-compatible", calls }), authority })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_test",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    const opts = calls[0] as { providerOptions?: Record<string, { stream?: boolean }> }
    expect(opts.providerOptions?.test?.stream).toBe(false)
  })

  test("model port still disables streaming when a compatible model is registered as openai", async () => {
    const calls: unknown[] = []
    const port = MemoryModel.port({
      provider: provider({
        npm: "@ai-sdk/openai-compatible",
        providerID: ProviderV2.ID.make("openai"),
        calls,
      }),
      authority,
    })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_test",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    const opts = calls[0] as { providerOptions?: Record<string, { stream?: boolean }> }
    expect(opts.providerOptions?.openai?.stream).toBe(false)
  })

  test("model port puts stream:false on the OpenAI-compatible request body", async () => {
    const seen: unknown[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json()
        seen.push(body)
        if ((body as { stream?: boolean }).stream !== false) {
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "The" } }] })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        return Response.json({
          id: "mem",
          object: "chat.completion",
          created: 0,
          model: "fake-memory-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"topic":"t","summary":"s"}',
                reasoning_content: "private-reasoning-secret",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const sdk = createOpenAICompatible({
        name: "test",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "unused",
      })
      const port = MemoryModel.port({
        provider: {
          ...provider({ npm: "@ai-sdk/openai-compatible" }),
          getLanguage: () => Effect.succeed(sdk.languageModel("fake-memory-model")),
        },
        authority,
      })
      const resolved = await Effect.runPromise(port.resolve({ session: ref }))
      const result = await port.run({
        handle: resolved.handle,
        sessionID: "ses_test",
        system: "system",
        prompt: "prompt",
        timeoutMs: 30_000,
      })

      expect((seen[0] as { stream?: boolean }).stream).toBe(false)
      expect(result.text).toBe('{"topic":"t","summary":"s"}')
      expect(result.text).not.toContain("private-reasoning-secret")
    } finally {
      server.stop(true)
    }
  })

  test("model port retries a transient provider failure once", async () => {
    const calls: unknown[] = []
    const err = new APICallError({
      message: "temporarily unavailable",
      url: "https://example.com/v1/generate",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: '{"error":"temporarily unavailable"}',
      isRetryable: true,
    })
    const port = MemoryModel.port({ provider: provider({ outputs: [err, "{}"], calls }), authority })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await port.run({
      handle: resolved.handle,
      sessionID: "ses_test",
      system: "system",
      prompt: "prompt",
      timeoutMs: 30_000,
    })

    expect(calls).toHaveLength(2)
    const opts = calls[0] as { providerOptions?: Record<string, { stream?: boolean }> }
    expect(opts.providerOptions?.test?.stream).toBeUndefined()
  })

  test("model port emits a structured timeout error", async () => {
    const port = MemoryModel.port({ provider: provider({ hang: true }), authority })
    const resolved = await Effect.runPromise(port.resolve({ session: ref }))

    await expect(
      port.run({ handle: resolved.handle, sessionID: "ses_test", system: "system", prompt: "prompt", timeoutMs: 1 }),
    ).rejects.toMatchObject({ name: "TimeoutError", message: "memory model timed out" })
  })

  test("model port clears its timeout after successful output", async () => {
    const set = globalThis.setTimeout
    const clear = globalThis.clearTimeout
    const handles = new Set<ReturnType<typeof setTimeout>>()
    const cleared = new Set<ReturnType<typeof setTimeout>>()

    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = set(...args)
      if (args[1] === 30_000) handles.add(handle)
      return handle
    }) as typeof setTimeout
    ;(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((
      handle?: Parameters<typeof clearTimeout>[0],
    ) => {
      if (handle && handles.has(handle as ReturnType<typeof setTimeout>)) {
        cleared.add(handle as ReturnType<typeof setTimeout>)
      }
      return clear(handle)
    }) as typeof clearTimeout

    try {
      const port = MemoryModel.port({ provider: provider({ outputs: ["{}"] }), authority })
      const resolved = await Effect.runPromise(port.resolve({ session: ref }))

      await port.run({
        handle: resolved.handle,
        sessionID: "ses_test",
        system: "system",
        prompt: "prompt",
        timeoutMs: 30_000,
      })
    } finally {
      ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = set
      ;(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = clear
    }

    expect(handles.size).toBe(1)
    expect(cleared.size).toBe(1)
  })
})

describe("memory turn", () => {
  function config(model?: string | null) {
    return { get: () => Effect.succeed({ memory_model: model }) }
  }

  async function close(model?: string | null, broken?: Effect.Effect<never, ModelNotFoundError>) {
    await using tmp = await tmpdir({ git: true })
    const seen: string[] = []
    const prior = Global.Path.data
    ;(Global.Path as { data: string }).data = path.join(tmp.path, "data")
    installMemoryRuntime()
    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const source = await AppRuntime.runPromise(SessionModule.Service.use((service) => service.create()))
          const sessionID = source.id
          const uid = MessageID.make("msg_turn_user")
          const final = MessageID.make("msg_turn_final")
          const messages = [
            user({ sessionID, id: uid, body: "Which command runs the CLI memory tests?" }),
            assistant({
              sessionID,
              id: final,
              parentID: uid,
              time: 2,
              parts: [text(sessionID, final, "Run bun test from packages/opencode for CLI memory tests.")],
            }),
          ]
          await KiloMemory.enable({ ctx })
          await Effect.runPromise(
            MemoryTurn.close({
              sessionID,
              reason: "completed",
              sessions: sessions(messages),
              summary: summary({ seen: [], diffs: [] }),
              provider: provider({
                seen,
                broken,
                outputs: [
                  '{"topic":"memory","summary":"Found the CLI memory test command.","operations":[],"skipped":[]}',
                ],
              }),
              config: config(model),
            }).pipe(
              Effect.provideService(InstanceRef, ctx),
              Effect.provideService(MemoryService.Service, MemoryService.make()),
            ),
          )
        },
      })
    } finally {
      ;(Global.Path as { data: string }).data = prior
    }
    return seen
  }

  test("close runs automatic saves on the configured memory_model", async () => {
    expect(await close("test/memory-config-model")).toEqual(["memory-config-model"])
  })

  test("close uses the session model when memory_model is unset", async () => {
    expect(await close()).toEqual(["fake-memory-model"])
  })

  test("close uses the session model when memory_model is null", async () => {
    expect(await close(null)).toEqual(["fake-memory-model"])
  })

  test("close falls back to the session model when memory_model is malformed", async () => {
    expect(await close("memory-config-model")).toEqual(["fake-memory-model"])
  })

  test("close falls back to the session model when memory_model is unavailable", async () => {
    expect(await close("test/missing-memory-model")).toEqual(["fake-memory-model"])
  })

  test("close fails closed when a configured utility SDK has an initialization defect", async () => {
    const broken = Effect.die(new Error("sdk failed to load"))
    expect(await close("test/memory-config-model", broken)).toEqual(["memory-config-model"])
  })
})
