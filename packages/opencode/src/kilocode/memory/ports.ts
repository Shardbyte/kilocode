import { generateText, streamText } from "ai"
import { Cause, Effect, Exit } from "effect"
import { MemoryConfig } from "@kilocode/kilo-memory/effect/config"
import { MemoryError } from "@kilocode/kilo-memory/effect/errors"
import type { MemoryPorts } from "@kilocode/kilo-memory/effect/ports"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { MemoryShared } from "@kilocode/kilo-memory/shared"
import * as Log from "@opencode-ai/core/util/log"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import type { SessionSummary } from "@/session/summary"
import type { Snapshot } from "@/snapshot"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionID } from "@/session/schema"
import { opencodeSessionHeaders } from "@/kilocode/provider/opencode-session-headers"
import { UtilityAccount } from "@/kilocode/provider/utility-account"

const log = Log.create({ service: "memory.ports" })

// --- Transcript extraction (host message model -> port TurnView) ------------------------------

function text(parts: MessageV2.Part[]) {
  return parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
    .map((part) => MemoryRedact.text(part.text.trim()))
    .filter(Boolean)
    .join("\n\n")
}

function output(parts: MessageV2.Part[]) {
  return parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text.trim()]
      if (part.type === "tool") return [toolSummary(part)]
      return []
    })
    .filter(Boolean)
    .join("\n")
}

function hidden(input: string) {
  const text = input.trim().replaceAll(/\s+/g, " ")
  if (!text) return ""
  if (MemoryRedact.has(text)) return "[redacted]"
  return MemoryShared.brief(text, 220)
}

function field(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? hidden(value) : ""
}

function exit(input: Record<string, unknown> | undefined) {
  const value = input?.exit
  if (typeof value !== "number" && typeof value !== "string") return ""
  return String(value)
}

function toolSummary(part: MessageV2.ToolPart) {
  const state = part.state
  const pieces = [`Tool ${part.tool} ${state.status}`]
  const command = field(state.input, "command")
  const file = field(state.input, "filePath")
  const pattern = field(state.input, "pattern")
  const query = field(state.input, "query")
  if (state.status === "completed" || state.status === "running") {
    const title = state.title ? hidden(state.title) : ""
    if (title) pieces.push(`title=${title}`)
  }
  if (command) pieces.push(`command=${command}`)
  if (file) pieces.push(`file=${file}`)
  if (pattern) pieces.push(`pattern=${pattern}`)
  if (query) pieces.push(`query=${query}`)
  if (state.status === "completed") {
    const code = exit(state.metadata)
    if (code) pieces.push(`exit=${code}`)
  }
  if (state.status === "error") {
    const error = hidden(state.error)
    if (error) pieces.push(`error=${error}`)
  }
  return pieces.join(" | ")
}

type UserTurn = MessageV2.WithParts & { info: MessageV2.User }
type AssistantTurn = MessageV2.WithParts & { info: MessageV2.Assistant }
type Turn = {
  user: UserTurn
  assistant: AssistantTurn
  assistants: AssistantTurn[]
}

function trace(messages: MessageV2.WithParts[], max: number) {
  return messages
    .flatMap((item) => {
      if (item.info.role === "user") {
        const body = text(item.parts)
        return body ? [`User: ${body}`] : []
      }
      if (item.info.role !== "assistant" || item.info.summary === true || item.info.error) return []
      const body = output(item.parts)
      return body ? [`Assistant: ${body}`] : []
    })
    .slice(-max)
    .join("\n\n")
}

function latest(messages: MessageV2.WithParts[]): Turn | undefined {
  const assistant = messages.findLast(
    (item): item is AssistantTurn =>
      item.info.role === "assistant" &&
      Boolean(item.info.finish) &&
      item.info.summary !== true &&
      !item.info.error &&
      Boolean(item.info.parentID),
  )
  if (!assistant) return
  const idx = messages.findIndex((item) => item.info.id === assistant.info.parentID)
  const user = idx >= 0 ? messages[idx] : undefined
  if (!user || user.info.role !== "user") return
  const assistants = messages
    .slice(idx + 1)
    .filter(
      (item): item is AssistantTurn =>
        item.info.role === "assistant" &&
        item.info.parentID === user.info.id &&
        item.info.summary !== true &&
        !item.info.error,
    )
  return { user: user as UserTurn, assistant, assistants }
}

/** True when the turn was answered from memory (targeted recall ran); digesting it would echo memory back into itself. */
function recalledMemory(turn: Turn) {
  return [turn.user, ...turn.assistants]
    .flatMap((item) => item.parts)
    .some((part) => {
      if (part.type === "tool") {
        return (
          part.tool === "kilo_memory_recall" &&
          part.state.status === "completed" &&
          typeof part.state.metadata.count === "number" &&
          part.state.metadata.count > 0
        )
      }
      if (part.type !== "text") return false
      const marker = (part.metadata as { kiloMemory?: { type?: string; count?: number } } | undefined)?.kiloMemory
      return marker?.type === "recall" && (marker.count ?? 0) > 0
    })
}

// --- Model resolution + invocation (host provider/`ai` -> port ModelHandle) --------------------

function consolidationOptions(model: Provider.Model) {
  if (model.api.npm === "@ai-sdk/openai-compatible") return { ...ProviderTransform.smallOptions(model), stream: false }
  if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") return { store: false }
  return ProviderTransform.smallOptions(model)
}

function consolidationPrompt(input: { model: Provider.Model; options: Record<string, unknown>; system: string }) {
  const openai = input.model.providerID === "openai" && input.model.api.npm === "@ai-sdk/openai"
  const options = openai ? { ...input.options, instructions: input.system } : input.options
  return {
    providerOptions: ProviderTransform.providerOptions(input.model, options),
    system: openai ? undefined : input.system,
  }
}

async function memoryText(input: {
  source: Provider.Model
  language: LanguageModelV3
  options: Record<string, unknown>
  system: string
  prompt: string
  timeoutMs: number
  sessionID: string
  temperature?: number
  topP?: number
  topK?: number
  signal?: AbortSignal
}) {
  const ctl = new AbortController()
  const ms = Math.max(1, input.timeoutMs)
  const params = consolidationPrompt({ model: input.source, options: input.options, system: input.system })
  const openai = input.source.providerID === "openai" && input.source.api.npm === "@ai-sdk/openai"
  const common = {
    model: input.language,
    ...(params.system ? { system: params.system } : {}),
    prompt: input.prompt,
    providerOptions: params.providerOptions,
    abortSignal: input.signal ? AbortSignal.any([ctl.signal, input.signal]) : ctl.signal,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxRetries: 1,
    headers: opencodeSessionHeaders({ providerID: input.source.providerID, sessionID: input.sessionID }),
  }
  const work = async () => {
    if (!openai) return generateText(common)

    const result = streamText(common)
    const text: string[] = []
    let usage: unknown
    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) text.push(part.text)
      if (part.type === "finish-step") usage = part.usage
      if (part.type === "finish") usage = part.totalUsage
      if (part.type === "error") throw part.error
    }
    return { text: text.join(""), usage }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new DOMException("memory model timed out", "TimeoutError"))
    }, ms)
  })
  try {
    return await Promise.race([work(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    ctl.abort()
  }
}

type ModelHandle = {
  source: Provider.Model
  session: MemoryPorts.ModelRef
  configured: boolean
  options: Record<string, unknown>
  temperature?: number
  topP?: number
  topK?: number
  invocation?: {
    sessionID: string
    prepared: Promise<{ authority: UtilityAccount.Identity; language: LanguageModelV3 }>
  }
}

// --- Ports -------------------------------------------------------------------------------------

/** Host SessionPort: extracts a TurnView from opencode's message store + snapshot diffs so the
 * package orchestrator never touches the host message model. */
export namespace MemorySession {
  export function port(input: {
    sessions: Session.Interface
    summary: SessionSummary.Interface
  }): MemoryPorts.SessionPort {
    return {
      readTurn: ({ sessionID, window }) =>
        Effect.gen(function* () {
          const messages = yield* input.sessions.messages({ sessionID: SessionID.make(sessionID), limit: window })
          const turn = latest(messages)
          if (!turn) return undefined
          const diffs = yield* input.summary.computeDiff({ messages: [turn.user, ...turn.assistants] }).pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                log.warn("memory turn diff unavailable", { error: String(err) })
                return [] as Snapshot.FileDiff[]
              }),
            ),
          )
          return {
            user: text(turn.user.parts),
            assistant: output(turn.assistant.parts),
            recent: trace(messages, 8),
            lastAssistantID: turn.assistant.info.id,
            sessionModel: {
              providerID: turn.user.info.model.providerID,
              modelID: turn.user.info.model.modelID,
            },
            recalledMemory: recalledMemory(turn),
            diffs,
          }
        }).pipe(Effect.mapError(MemoryError.from)),
      get: ({ sessionID }) =>
        input.sessions.get(SessionID.make(sessionID)).pipe(
          Effect.map((info) => ({ parentID: info.parentID })),
          Effect.mapError(MemoryError.from),
        ),
    }
  }
}

/** Host ModelPort: resolves the consolidation model through opencode's provider and runs it via the
 * `ai` SDK, exposing the resolved model to the package as an opaque handle. */
export namespace MemoryModel {
  export function port(input: {
    provider: Provider.Interface
    authority: (model: Provider.Model, sessionID: string) => Promise<UtilityAccount.Identity>
  }): MemoryPorts.ModelPort {
    return {
      resolve: ({ configured, session }) =>
        Effect.gen(function* () {
          const parsed = MemoryConfig.parse(configured)
          const load = (ref: MemoryPorts.ModelRef) =>
            input.provider.getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID))
          const build = (source: Provider.Model, configured: boolean) => ({
            source,
            session,
            configured,
            options: consolidationOptions(source),
            temperature: ProviderTransform.temperature(source),
            topP: ProviderTransform.topP(source),
            topK: ProviderTransform.topK(source),
          })
          const fallback = (reason: string) => {
            log.warn("memory model config ignored", { reason })
            return load(session).pipe(Effect.map((source) => ({ handle: build(source, false), fallback: { reason } })))
          }
          if (configured && !parsed) return yield* fallback("invalid model")
          if (!parsed) return { handle: build(yield* load(session), false) }
          return yield* load(parsed).pipe(
            Effect.map((source) => ({ handle: build(source, true) })),
            Effect.catch((err) =>
              Provider.ModelNotFoundError.isInstance(err) ? fallback("model unavailable") : Effect.fail(err),
            ),
          )
        }).pipe(Effect.mapError(MemoryError.from)),
      run: ({ handle, sessionID, system, prompt, timeoutMs, signal }) => {
        const resolved = handle as ModelHandle
        return (async () => {
          const { AppRuntime } = await import("@/effect/app-runtime")
          if (resolved.invocation && resolved.invocation.sessionID !== sessionID)
            throw new Error("The memory invocation does not match its source session")
          resolved.invocation ??= {
            sessionID,
            prepared: Promise.resolve().then(async () => {
              const auth = await input.authority(resolved.source, sessionID)
              if (
                auth.sourceSessionID !== sessionID ||
                auth.providerID !== resolved.source.providerID ||
                auth.modelID !== resolved.source.id ||
                (auth.mode === "profile" && resolved.source.api.npm !== "@ai-sdk/openai")
              )
                throw new UtilityAccount.Failure("context-mismatch")
              const exit = await AppRuntime.runPromise(
                Effect.exit(
                  Effect.suspend(() =>
                    input.provider.getLanguage(resolved.source, auth.mode === "profile" ? auth.profileID : undefined),
                  ),
                ),
              )
              if (Exit.isSuccess(exit)) return { authority: auth, language: exit.value }
              const reasons = exit.cause.reasons
              const reason = reasons.length === 1 ? reasons.at(0) : undefined
              const missing =
                reason && Cause.isFailReason(reason) && Provider.ModelNotFoundError.isInstance(reason.error)
              const defect = reason && Cause.isDieReason(reason)
              if (!resolved.configured || (!missing && !(defect && auth.mode === "legacy")))
                throw Cause.squash(exit.cause)
              const source = await AppRuntime.runPromise(
                input.provider.getModel(
                  ProviderV2.ID.make(resolved.session.providerID),
                  ModelV2.ID.make(resolved.session.modelID),
                ),
              )
              const next = await input.authority(source, sessionID)
              if (
                next.sourceSessionID !== sessionID ||
                next.providerID !== source.providerID ||
                next.modelID !== source.id ||
                next.mode !== auth.mode ||
                (auth.mode === "profile" && (next.mode !== "profile" || next.profileID !== auth.profileID)) ||
                (next.mode === "profile" && source.api.npm !== "@ai-sdk/openai")
              )
                throw new UtilityAccount.Failure("context-mismatch")
              const loaded = await AppRuntime.runPromise(
                Effect.exit(
                  Effect.suspend(() =>
                    input.provider.getLanguage(source, next.mode === "profile" ? next.profileID : undefined),
                  ),
                ),
              )
              if (!Exit.isSuccess(loaded)) throw Cause.squash(loaded.cause)
              log.warn("memory model config ignored", { reason: "model unavailable" })
              resolved.source = source
              resolved.configured = false
              resolved.options = consolidationOptions(source)
              resolved.temperature = ProviderTransform.temperature(source)
              resolved.topP = ProviderTransform.topP(source)
              resolved.topK = ProviderTransform.topK(source)
              return { authority: next, language: loaded.value }
            }),
          }
          const prepared = await resolved.invocation.prepared
          return memoryText({
            source: resolved.source,
            language: prepared.language,
            options:
              prepared.authority.mode === "profile"
                ? { ...resolved.options, instructions: system, store: false }
                : resolved.options,
            system,
            prompt,
            timeoutMs,
            sessionID,
            temperature: resolved.temperature,
            topP: resolved.topP,
            topK: resolved.topK,
            signal,
          })
        })().catch((err) => {
          if (err instanceof DOMException && err.name === "TimeoutError")
            throw new DOMException("memory model timed out", "TimeoutError")
          if (err instanceof DOMException && err.name === "AbortError")
            throw new DOMException("memory model cancelled", "AbortError")
          if (err instanceof UtilityAccount.Failure) throw err
          throw new Error("Memory utility generation failed")
        })
      },
    }
  }
}
