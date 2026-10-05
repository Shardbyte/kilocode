import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { tmpdir } from "../fixture/tmpdir"

const secret = {
  access: "dispatch-sentinel-access-71a9",
  refresh: "dispatch-sentinel-refresh-71a9",
  expires: 1_900_000_000_000,
  accountID: "dispatch-sentinel-account-71a9",
} satisfies ProviderAccountProfiles.Secret

function run<A, E>(
  filename: string,
  body: (
    service: ProviderAccountProfiles.Interface,
  ) => Effect.Effect<A, E, ProviderAccountProfiles.Service | Database.Service>,
) {
  const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [
    [Database.node, Database.layerFromPath(filename).pipe(Layer.fresh)],
  ])
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* ProviderAccountProfiles.Service)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

const worker = (filename: string, id: string) => `
  const { Effect, Layer } = await import("effect")
  const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
  const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
  const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
  const { Cause } = await import("effect")
  const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [
    [Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)],
  ])
  const lines = (async function* () {
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const item = await reader.read()
      if (item.done) return
      buf += decoder.decode(item.value, { stream: true })
      while (buf.includes("\\n")) {
        const at = buf.indexOf("\\n")
        yield buf.slice(0, at)
        buf = buf.slice(at + 1)
      }
    }
  })()
  const send = (value) => console.log(JSON.stringify(value))
  const causeText = (exit) => exit._tag === "Failure" ? Cause.prettyErrors(exit.cause).join("\\n") : ""
  const probe = ${JSON.stringify(`
    const { Database } = require("bun:sqlite")
    const db = new Database(${JSON.stringify(filename)})
    db.run("PRAGMA busy_timeout = 0")
    try {
      db.run("BEGIN IMMEDIATE")
      db.run("ROLLBACK")
      process.stdout.write("ACQUIRED")
    } catch (error) {
      process.stdout.write(error.code === "SQLITE_BUSY" ? "BUSY" : "OTHER")
    } finally { db.close() }
  `)}
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* ProviderAccountProfiles.Service
    const gate = Promise.withResolvers()
    const exit = yield* Effect.exit(service.dispatch(${JSON.stringify(id)}, (credential, revision) => {
      const lock = Bun.spawnSync([process.execPath, "-e", probe], { stdout: "pipe", stderr: "pipe" })
      send({ type: "handoff", accessMatch: credential.access === ${JSON.stringify(secret.access)}, revision, lock: lock.stdout.toString(), probeError: lock.stderr.toString() })
      return gate.promise
    }))
    if (exit._tag === "Failure") {
      send({ type: "denied", error: causeText(exit) })
      return
    }
    send({ type: "pending" })
    const cmd = yield* Effect.promise(() => lines.next())
    if (cmd.done || JSON.parse(cmd.value).type !== "release") throw new Error("Expected release command")
    gate.resolve("synthetic response complete")
    send({ type: "response", value: yield* Effect.promise(() => exit.value.response) })
    const retry = yield* Effect.promise(() => lines.next())
    if (retry.done || JSON.parse(retry.value).type !== "retry") throw new Error("Expected retry command")
    let called = false
    const retried = yield* Effect.exit(service.dispatch(${JSON.stringify(id)}, () => {
      called = true
      return Promise.resolve("unexpected transport")
    }))
    send({ type: "retry", denied: retried._tag === "Failure", called, error: causeText(retried) })
  }).pipe(Effect.provide(layer), Effect.scoped))
  await lines.return()
  process.exit(0)
`

function launch(filename: string, id: string) {
  const child = Bun.spawn([process.execPath, "-e", worker(filename, id)], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let transcript = ""
  const next = async () => {
    while (!buf.includes("\n")) {
      const item = await reader.read()
      if (item.done)
        throw new Error(
          `Dispatch worker exited before its next event: ${await child.exited}; ${await new Response(child.stderr).text()}`,
        )
      const text = decoder.decode(item.value, { stream: true })
      transcript += text
      buf += text
    }
    const at = buf.indexOf("\n")
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    return JSON.parse(line) as Record<string, unknown>
  }
  const send = async (type: string) => child.stdin.write(`${JSON.stringify({ type })}\n`)
  const output = async () => ({
    out: transcript,
    err: await new Response(child.stderr).text(),
  })
  return { child, next, send, output }
}

test("dispatch hands off under SQLite writer lock, then removal denies retry", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "dispatch.db")
  const account = await run(filename, (service) =>
    Effect.gen(function* () {
      return yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Cross-process dispatch",
        credential: secret,
      })
    }),
  )

  const proc = launch(filename, account.id)
  try {
    const handoff = await proc.next()
    expect(handoff).toMatchObject({ type: "handoff", accessMatch: true, revision: 0, lock: "BUSY", probeError: "" })
    expect(await proc.next()).toEqual({ type: "pending" })

    await run(filename, (service) => service.remove(account.id))
    expect(await run(filename, (service) => service.get(account.id))).toBeUndefined()

    await proc.send("release")
    expect(await proc.next()).toEqual({ type: "response", value: "synthetic response complete" })
    await proc.send("retry")
    const retry = await proc.next()
    expect(retry).toMatchObject({ type: "retry", denied: true, called: false })
    expect(String(retry.error)).toContain("ProviderAccountProfiles.AccountUnavailableError")
    expect(await proc.child.exited).toBe(0)
    const out = await proc.output()
    expect(out.err).toBe("")
    expect(out.out).not.toContain(secret.access)
    expect(out.out).not.toContain(secret.refresh)
    expect(out.out).not.toContain(secret.accountID)
    expect(out.err).not.toContain(secret.access)
    expect(out.err).not.toContain(secret.refresh)
    expect(out.err).not.toContain(secret.accountID)
  } finally {
    if (proc.child.exitCode === null) proc.child.kill(9)
    await proc.child.exited
  }
})

test("dispatch after another process deleted the profile never calls transport", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "deleted-before-dispatch.db")
  const account = await run(filename, (service) =>
    service.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Deleted before dispatch",
      credential: secret,
    }),
  )
  await run(filename, (service) => service.remove(account.id))

  const proc = launch(filename, account.id)
  try {
    const denied = await proc.next()
    expect(denied.type).toBe("denied")
    expect(String(denied.error)).toContain("ProviderAccountProfiles.AccountUnavailableError")
    expect(await proc.child.exited).toBe(0)
    const out = await proc.output()
    expect(out.err).toBe("")
    expect(out.out).not.toContain(secret.access)
    expect(out.out).not.toContain(secret.refresh)
    expect(out.out).not.toContain(secret.accountID)
    expect(out.err).not.toContain(secret.access)
    expect(out.err).not.toContain(secret.refresh)
    expect(out.err).not.toContain(secret.accountID)
  } finally {
    if (proc.child.exitCode === null) proc.child.kill(9)
    await proc.child.exited
  }
})
