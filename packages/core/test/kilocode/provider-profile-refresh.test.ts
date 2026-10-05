import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { tmpdir } from "../fixture/tmpdir"

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

const worker = (filename: string, mode: "owner" | "waiter" | "other", id: string) => `
  const { Clock, Effect, Layer } = await import("effect")
  const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
  const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
  const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
  const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [
    [Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)],
  ])
  const input = (async function* () {
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const item = await reader.read()
      if (item.done) return
      buf += decoder.decode(item.value, { stream: true })
      while (buf.includes("\\n")) {
        const at = buf.indexOf("\\n")
        yield JSON.parse(buf.slice(0, at))
        buf = buf.slice(at + 1)
      }
    }
  })()
  const send = (type) => console.log(JSON.stringify({ type, pid: process.pid }))
  const command = async (expected) => {
    const item = await input.next()
    if (item.done || item.value.type !== expected) throw new Error("Unexpected barrier command")
  }
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* ProviderAccountProfiles.Service
    const hold = (label) => Effect.promise(async () => {
      send(label)
      await command("release-" + label)
    })
    if (${JSON.stringify(mode)} === "owner") {
      yield* service.withRefresh(${JSON.stringify(id)}, hold("owner-entered"))
      send("owner-released")
    }
    if (${JSON.stringify(mode)} === "other") {
      yield* service.withRefresh(${JSON.stringify(id)}, hold("other-entered"))
      send("other-released")
    }
    if (${JSON.stringify(mode)} === "waiter") {
      const clock = {
        currentTimeMillisUnsafe: () => Date.now(),
        currentTimeMillis: Effect.sync(() => Date.now()),
        currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1000000n,
        currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1000000n),
        sleep: () => Effect.promise(async () => {
          send("contention-observed")
          await command("release-contention")
        }),
      }
      yield* service.withRefresh(${JSON.stringify(id)}, hold("waiter-entered")).pipe(
        Effect.provideService(Clock.Clock, clock),
      )
      send("waiter-released")
    }
  }).pipe(Effect.provide(layer), Effect.scoped))
  await input.return()
  process.exit(0)
`

function launch(filename: string, mode: "owner" | "waiter" | "other", id: string) {
  const child = Bun.spawn([process.execPath, "-e", worker(filename, mode, id)], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const next = async () => {
    while (!buf.includes("\n")) {
      const item = await reader.read()
      if (item.done)
        throw new Error(
          `Refresh worker exited before its next event: ${await child.exited}; ${await new Response(child.stderr).text()}`,
        )
      buf += decoder.decode(item.value, { stream: true })
    }
    const at = buf.indexOf("\n")
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    return JSON.parse(line) as { type: string; pid: number }
  }
  const send = async (type: string) => child.stdin.write(`${JSON.stringify({ type })}\n`)
  const output = async () => new Response(child.stderr).text()
  return { child, next, send, output }
}

test("cross-process refresh lock waits for the owning account while unrelated accounts proceed", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "refresh-lock.db")
  const ids = await run(filename, (service) =>
    Effect.gen(function* () {
      const a = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Refresh A",
        credential: { access: "synthetic-a", refresh: "synthetic-ra", expires: 1 },
      })
      const b = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Refresh B",
        credential: { access: "synthetic-b", refresh: "synthetic-rb", expires: 1 },
      })
      return { a: a.id, b: b.id }
    }),
  )

  const owner = launch(filename, "owner", ids.a)
  let waiter: ReturnType<typeof launch> | undefined
  let other: ReturnType<typeof launch> | undefined
  try {
    const owned = await owner.next()
    expect(owned.type).toBe("owner-entered")
    waiter = launch(filename, "waiter", ids.a)
    const wait = waiter

    // This event is emitted only from Clock.sleep, which withRefresh reaches after
    // its real DB transaction observed the account lock owned by the other process.
    const blocked = await wait.next()
    expect(blocked.type).toBe("contention-observed")
    expect(blocked.pid).not.toBe(owned.pid)

    other = launch(filename, "other", ids.b)
    const independent = await other.next()
    expect(independent.type).toBe("other-entered")
    expect(independent.pid).not.toBe(owned.pid)
    expect(independent.pid).not.toBe(blocked.pid)
    await other.send("release-other-entered")
    expect(await other.next()).toMatchObject({ type: "other-released" })
    expect(await other.child.exited).toBe(0)

    await owner.send("release-owner-entered")
    expect(await owner.next()).toMatchObject({ type: "owner-released" })
    expect(await owner.child.exited).toBe(0)

    await wait.send("release-contention")
    expect(await wait.next()).toMatchObject({ type: "waiter-entered" })
    await wait.send("release-waiter-entered")
    expect(await wait.next()).toMatchObject({ type: "waiter-released" })
    expect(await wait.child.exited).toBe(0)
    expect(await Promise.all([owner.output(), wait.output(), other.output()])).toEqual(["", "", ""])
  } finally {
    for (const proc of [owner, waiter, other]) {
      if (proc?.child.exitCode === null) proc.child.kill(9)
    }
    await Promise.all([
      owner.child.exited,
      ...(waiter ? [waiter.child.exited] : []),
      ...(other ? [other.child.exited] : []),
    ])
  }
}, 30_000)
