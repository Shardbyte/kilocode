import { tmpdir } from "../../fixture/fixture"
import { stat } from "node:fs/promises"
import { expect, test } from "bun:test"
import { create, lease } from "@/kilocode/provider/codex-diagnostic"
import { makeFetch } from "@/kilocode/provider/codex-profile"
import { KiloSessionProcessor } from "@/kilocode/session/processor"
import { MessageV2 } from "@/session/message-v2"

const poison = "PRIVATE_TOKEN_ACCOUNT_PROMPT_ERROR_123"
function fixture(opts: { ttl?: number; deadline?: number; now?: () => number } = {}) {
  const reports: unknown[] = []
  const observer = create({ profile: poison, ...opts, publish: (report) => reports.push(structuredClone(report)) })
  return { observer, reports, read: () => JSON.stringify(reports.at(-1)) }
}
const init = {
  method: "POST",
  headers: { authorization: poison, "chatgpt-account-id": poison, originator: poison },
  body: JSON.stringify({
    model: "gpt-6-luna",
    instructions: poison,
    input: [{ role: "user", content: poison }],
    reasoning: { effort: "low" },
    store: false,
    stream: true,
  }),
}

test("disabled by default; no profile identifiers, prompts, header values, or arbitrary upstream values escape", async () => {
  expect(lease).toBeUndefined()
  const f = fixture()
  const body = {
    model: poison,
    instructions: poison,
    input: [{ role: poison, content: poison }],
    reasoning: { effort: poison },
    metadata: { [poison]: poison },
    [poison]: poison,
    store: poison,
    stream: poison,
  }
  const record = f.observer.observe(poison, { ...init, body: JSON.stringify(body) })!
  const response = Response.json(
    { error: { code: poison, type: poison, message: poison, param: poison }, [poison]: poison },
    { status: 400, headers: { authorization: poison } },
  )
  await record.response(response)
  expect(f.read()).not.toContain(poison)
  expect(f.read()).toContain('"model":"unknown"')
  expect(f.read()).toContain('"effort":"unknown"')
  expect(f.read()).toContain('"category":"unknown"')
  expect(await response.json()).toEqual({
    error: { code: poison, type: poison, message: poison, param: poison },
    [poison]: poison,
  })
  f.observer.stop()
})

test("records actual serialized catalog model and effort with closed body projections", async () => {
  const f = fixture()
  await f.observer
    .observe(poison, init)!
    .response(Response.json({ error: { code: "unsupported_value", message: poison } }, { status: 400 }))
  const text = f.read()
  expect(text).toContain('"model":"gpt-6-luna"')
  expect(text).toContain('"effort":"low"')
  expect(text).toContain('"instructions":true')
  expect(text).toContain('"store":false')
  expect(text).toContain('"stream":true')
  expect(text).toContain('"category":"unsupported-option"')
  expect(text).not.toContain(poison)
  f.observer.stop()
})

test.each([
  { text: "{bad", result: "malformed" },
  { text: JSON.stringify({ error: { message: poison.repeat(300) } }), result: "oversized" },
  { text: "[".repeat(17) + "0" + "]".repeat(17), result: "malformed" },
  { text: JSON.stringify({ error: { code: "constructor", message: poison } }), result: "complete" },
])("bounded error inspection rejects unsafe input %s", async ({ text, result }) => {
  const f = fixture()
  const response = new Response(text, { status: 400 })
  await f.observer.observe(poison, init)!.response(response)
  expect(f.read()).toContain(`"inspection":"${result}"`)
  expect(f.read()).toContain('"category":"unknown"')
  expect(f.read()).not.toContain(poison)
  expect(await response.text()).toBe(text)
  f.observer.stop()
})

test("oversized, deep, non-string, and Request bodies stay uninspected", async () => {
  for (const body of [poison.repeat(20_000), "[".repeat(17) + "0" + "]".repeat(17), new Blob([poison])]) {
    const f = fixture()
    f.observer.observe(poison, { body })
    expect(f.read()).toContain('"inspection":"uninspected"')
    expect(f.read()).not.toContain(poison)
    f.observer.stop()
  }
  const f = fixture()
  const request = new Request("https://api.openai.com/v1/responses", { method: "POST", body: poison })
  f.observer.observe(poison, {})
  expect(request.bodyUsed).toBe(false)
  expect(await request.text()).toBe(poison)
  f.observer.stop()
})

test("deadline and caller cancellation do not consume or cancel the caller response", async () => {
  for (const abort of [false, true]) {
    const f = fixture({ deadline: 10 })
    const controller = new AbortController()
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    const response = new Response(stream.readable, { status: 400 })
    const record = f.observer.observe(poison, { ...init, signal: controller.signal })!
    const pending = record.response(response)
    if (abort) controller.abort()
    await pending
    expect(f.read()).toContain(`"inspection":"${abort ? "cancelled" : "timeout"}"`)
    expect(response.bodyUsed).toBe(false)
    const read = response.text()
    await writer.write(new TextEncoder().encode("original"))
    await writer.close()
    expect(await read).toBe("original")
    f.observer.stop()
  }
})

test("exact-profile isolation, three records, lease expiry, and explicit stop", async () => {
  let now = 0
  const f = fixture({ now: () => now, ttl: 10 })
  expect(f.observer.observe("other", init)).toBeUndefined()
  for (const _ of [1, 2, 3]) expect(f.observer.observe(poison, init)).toBeDefined()
  expect(f.observer.observe(poison, init)).toBeUndefined()
  expect(JSON.parse(f.read()).records).toHaveLength(3)
  const last = f.read()
  now = 10
  expect(f.observer.observe(poison, init)).toBeUndefined()
  expect(f.read()).toBe(last)
  f.observer.stop()
  const g = fixture()
  g.observer.stop()
  expect(g.observer.observe(poison, init)).toBeUndefined()
})

test("expiry cancels pending diagnostics without late publication", async () => {
  const f = fixture({ ttl: 10 })
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const response = new Response(stream.readable, { status: 400 })
  const pending = f.observer.observe(poison, init)!.response(response)
  const count = f.reports.length
  await pending
  expect(f.reports).toHaveLength(count)
  f.observer.stop()
  const reader = response.body!.getReader()
  void reader.cancel()
})

test("publish failures disable the lease without changing inference", () => {
  const observer = create({
    profile: poison,
    publish: () => {
      throw new Error(poison)
    },
  })
  expect(observer.observe(poison, init)).toBeDefined()
  expect(observer.observe(poison, init)).toBeUndefined()
  observer.stop()
})

test("real profile adapter preserves body, exact authority, response, and sanitized errors; never rotates or retries", async () => {
  const f = fixture()
  const calls: string[] = []
  const response = Response.json({ error: { code: "model_not_found", message: poison } }, { status: 400 })
  const adapter = makeFetch(
    poison,
    {
      refresh: async (id) => {
        calls.push(`refresh:${id}`)
      },
      dispatch: async (id, transport) => {
        calls.push(`dispatch:${id}`)
        return {
          response: transport({ access: poison, refresh: poison, accountID: poison, expires: Date.now() + 60_000 }, 0),
        }
      },
      request: async (url, options) => {
        expect(url instanceof URL ? url.href : typeof url === "string" ? url : url.url).toBe(
          "https://chatgpt.com/backend-api/codex/responses",
        )
        expect(options!.body).toBe(init.body)
        expect(new Headers(options!.headers).get("authorization")).toBe(`Bearer ${poison}`)
        return response
      },
    },
    f.observer,
  )
  expect(await adapter("https://api.openai.com/v1/responses", init)).toBe(response)
  expect(await response.text()).toContain(poison)
  expect(calls).toEqual([`refresh:${poison}`, `dispatch:${poison}`])
  const safe = KiloSessionProcessor.profileError(
    new MessageV2.APIError({ message: poison, statusCode: 400, isRetryable: false, responseBody: poison }),
  )
  expect(safe).toMatchObject({
    name: "APIError",
    data: { message: "The selected provider account request failed.", statusCode: 400 },
  })
  expect(JSON.stringify(safe)).not.toContain(poison)
  f.observer.stop()
})

test("chunked JSON classification leaves the caller stream unchanged; SSE errors are never persisted", async () => {
  const f = fixture()
  const text = JSON.stringify({ error: { code: "missing_required_parameter", message: poison } })
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text.slice(0, 15)))
        controller.enqueue(new TextEncoder().encode(text.slice(15)))
        controller.close()
      },
    }),
    { status: 400 },
  )
  await f.observer.observe(poison, init)!.response(response)
  expect(f.read()).toContain('"category":"missing-parameter"')
  expect(await response.text()).toBe(text)
  const sse = new Response(`data: ${poison}\n\n`, { headers: { "content-type": "text/event-stream" } })
  await f.observer.observe(poison, init)!.response(sse)
  expect(f.read()).toContain('"inspection":"uninspected"')
  expect(f.read()).not.toContain(poison)
  expect(await sse.text()).toContain(poison)
  f.observer.stop()
})

test("startup requires explicit opt-in, creates a private valid report, and refuses existing files", async () => {
  await using tmp = await tmpdir()
  const path = `${tmp.path}/diagnostic.json`
  const module = new URL("../../../src/kilocode/provider/codex-diagnostic.ts", import.meta.url).pathname
  const script = `const { lease } = await import(${JSON.stringify(module)}); if (lease) { const record = lease.observe(${JSON.stringify(poison)}, ${JSON.stringify(init)}); await record?.response(Response.json({error:{code:"unsupported_model",message:${JSON.stringify(poison)}}},{status:400})); lease.stop() } console.log(!!lease)`
  const run = async (enabled: string) => {
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: {
        ...process.env,
        KILO_CODEX_DIAGNOSTIC: enabled,
        KILO_CODEX_DIAGNOSTIC_PROFILE: poison,
        KILO_CODEX_DIAGNOSTIC_REPORT: path,
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return output.trim()
  }
  expect(await run("0")).toBe("false")
  expect(await Bun.file(path).exists()).toBe(false)
  expect(await run("1")).toBe("true")
  const text = await Bun.file(path).text()
  expect(JSON.parse(text).records).toHaveLength(1)
  expect(text).not.toContain(poison)
  expect(text).toContain('"category":"unsupported-model"')
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await run("1")).toBe("false")
  expect(await Bun.file(path).text()).toBe(text)
})

test("profile inference returns before a stalled diagnostic read and preserves transport failures", async () => {
  const f = fixture()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const response = new Response(stream.readable, { status: 400 })
  const calls: string[] = []
  const adapter = makeFetch(
    poison,
    {
      refresh: async (id) => {
        calls.push(id)
      },
      dispatch: async (id, transport) => ({
        response: transport({ access: poison, refresh: poison, expires: Date.now() + 60_000 }, 0),
      }),
      request: async () => response,
    },
    f.observer,
  )
  expect(await adapter("https://api.openai.com/v1/responses", init)).toBe(response)
  expect(f.read()).not.toContain('"result"')
  f.observer.stop()
  void response.body!.cancel()
  const g = fixture()
  const failing = makeFetch(
    poison,
    {
      refresh: async (id) => {
        calls.push(id)
      },
      dispatch: async (id, transport) => ({
        response: transport({ access: poison, refresh: poison, expires: Date.now() + 60_000 }, 0),
      }),
      request: async () => {
        throw new Error(poison)
      },
    },
    g.observer,
  )
  await failing("https://api.openai.com/v1/responses", init).then(
    () => {
      throw new Error("Expected transport failure")
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(Error)
      expect(err instanceof Error ? err.message : "").toBe(poison)
    },
  )
  expect(calls).toEqual([poison, poison])
  expect(g.read()).toContain('"category":"transport-failure"')
  expect(g.read()).not.toContain(poison)
  g.observer.stop()
})
