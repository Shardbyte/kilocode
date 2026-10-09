import { randomUUID } from "node:crypto"
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs"
import { isAbsolute } from "node:path"

const models = ["gpt-5.4", "gpt-6-luna"] as const
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
const fields = [
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "reasoning",
  "text",
  "include",
  "store",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "service_tier",
  "parallel_tool_calls",
  "previous_response_id",
  "metadata",
  "truncation",
  "user",
] as const
const names = [
  "authorization",
  "chatgpt-account-id",
  "originator",
  "user-agent",
  "session-id",
  "content-type",
  "openai-beta",
] as const
const codes = {
  invalid_api_key: "authorization",
  token_expired: "authorization",
  model_not_found: "unsupported-model",
  unsupported_model: "unsupported-model",
  unsupported_parameter: "unsupported-option",
  unsupported_value: "unsupported-option",
  missing_required_parameter: "missing-parameter",
  invalid_request_error: "invalid-request",
} as const

type Category = (typeof codes)[keyof typeof codes] | "unknown" | "service-rejection" | "transport-failure"
type Inspection = "complete" | "uninspected" | "oversized" | "malformed" | "timeout" | "cancelled" | "unavailable"
type Result = { inspection: Inspection; category: Category }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function choice<const T extends readonly string[]>(values: T, value: unknown): T[number] | "unknown" {
  return typeof value === "string" && values.includes(value) ? value : "unknown"
}

function shape(value: unknown) {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (object(value)) return "object"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return "number"
  return "string"
}

function parse(text: string, limit: number): unknown {
  if (text.length > limit || Buffer.byteLength(text) > limit) return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  for (const char of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (quoted && char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char === "{" || char === "[") depth++
    if (char === "}" || char === "]") depth--
    if (depth > 16) return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function project(init: RequestInit) {
  const body = typeof init.body === "string" ? parse(init.body, 262_144) : undefined
  const headers = new Headers(init.headers)
  const presence = Object.fromEntries(names.map((name) => [name, headers.has(name)]))
  const method = choice(["POST", "GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const, init.method ?? "GET")
  if (!object(body)) return { method, headers: presence, body: { inspection: "uninspected" as const } }
  const roles = { system: 0, developer: 0, user: 0, assistant: 0, tool: 0, unknown: 0 }
  const input = Array.isArray(body.input) ? body.input : undefined
  for (const item of input?.slice(0, 128) ?? []) {
    const role = object(item)
      ? choice(["system", "developer", "user", "assistant", "tool"] as const, item.role)
      : "unknown"
    roles[role]++
  }
  return {
    method,
    headers: presence,
    body: {
      inspection: "complete" as const,
      model: choice(models, body.model),
      effort: choice(efforts, object(body.reasoning) ? body.reasoning.effort : undefined),
      instructions: typeof body.instructions === "string" && body.instructions.length > 0,
      store: typeof body.store === "boolean" ? body.store : "unknown",
      stream: typeof body.stream === "boolean" ? body.stream : "unknown",
      fields: Object.fromEntries(fields.map((name) => [name, shape(body[name])])),
      unknown: Math.min(128, Object.keys(body).filter((name) => !fields.some((field) => field === name)).length),
      roles,
      truncated: (input?.length ?? 0) > 128,
    },
  }
}

async function inspect(response: Response, signal: AbortSignal, deadline: number): Promise<Result> {
  if (response.status < 400) return { inspection: "uninspected", category: "unknown" }
  if (response.status === 401 || response.status === 403)
    return { inspection: "uninspected", category: "authorization" }
  if (response.status >= 500) return { inspection: "uninspected", category: "service-rejection" }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), deadline)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (controller.signal.aborted) return { inspection: "cancelled", category: "unknown" }
    reader = response.clone().body?.getReader()
    if (!reader) return { inspection: "unavailable", category: "unknown" }
    const stopped = Promise.withResolvers<undefined>()
    const abort = () => stopped.resolve(undefined)
    controller.signal.addEventListener("abort", abort, { once: true })
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), stopped.promise])
        if (!next) return { inspection: signal.aborted ? "cancelled" : "timeout", category: "unknown" }
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 4096) return { inspection: "oversized", category: "unknown" }
        chunks.push(next.value)
      }
      const body = parse(Buffer.concat(chunks).toString("utf8"), 4096)
      if (!object(body) || !object(body.error)) return { inspection: "malformed", category: "unknown" }
      const code = body.error.code
      const category = Object.entries(codes).find(([name]) => name === code)?.[1] ?? "unknown"
      return { inspection: "complete", category }
    } finally {
      controller.signal.removeEventListener("abort", abort)
    }
  } catch {
    return { inspection: "unavailable", category: "unknown" }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
    // Cancelling a tee branch may wait for the caller's branch; never await it.
    if (reader) void reader.cancel().catch(() => undefined)
  }
}

export function create(opts: {
  profile: string
  ttl?: number
  deadline?: number
  now?: () => number
  publish: (report: unknown) => void
}) {
  const now = opts.now ?? Date.now
  const expires = now() + Math.min(600_000, Math.max(1, opts.ttl ?? 600_000))
  const operation = randomUUID()
  const records: Array<{ request: ReturnType<typeof project>; status?: number; result?: Result }> = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(600_000, Math.max(1, opts.ttl ?? 600_000)))
  timer.unref()
  const stop = () => {
    controller.abort()
    clearTimeout(timer)
  }
  const active = () => !controller.signal.aborted && now() < expires
  const publish = () => {
    if (!active()) return
    try {
      opts.publish({ operation, provider: "openai", transport: "http", endpoint: "codex-responses", expires, records })
    } catch {
      stop()
    }
  }
  return {
    stop,
    observe: (profile: string, init: RequestInit) => {
      if (profile !== opts.profile || !active() || records.length >= 3) return undefined
      const record: (typeof records)[number] = { request: project(init) }
      records.push(record)
      publish()
      return {
        response: (response: Response) => {
          if (!active()) return Promise.resolve()
          record.status = response.status
          publish()
          return inspect(
            response,
            init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
            Math.min(250, Math.max(1, opts.deadline ?? 250)),
          ).then((result) => {
            if (!active()) return
            record.result = result
            publish()
          })
        },
        failure: () => {
          if (!active()) return
          record.result = { inspection: "uninspected", category: "transport-failure" }
          publish()
        },
      }
    },
  }
}

function startup() {
  if (process.env.KILO_CODEX_DIAGNOSTIC !== "1") return undefined
  const profile = process.env.KILO_CODEX_DIAGNOSTIC_PROFILE
  const path = process.env.KILO_CODEX_DIAGNOSTIC_REPORT
  delete process.env.KILO_CODEX_DIAGNOSTIC_PROFILE
  if (!profile || !path || !isAbsolute(path)) return undefined
  try {
    // A new, private file only: never overwrite an existing report or follow a symlink.
    const fd = openSync(path, "wx", 0o600)
    const lease = create({
      profile,
      publish: (report) => {
        const text = JSON.stringify(report) + "\n"
        ftruncateSync(fd, 0)
        writeSync(fd, text, 0, "utf8")
      },
    })
    process.once("exit", () => {
      lease.stop()
      closeSync(fd)
    })
    return lease
  } catch {
    return undefined
  }
}

export const lease = startup()
