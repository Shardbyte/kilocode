import { expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { tmpdir } from "../fixture/tmpdir"

function run<A, E>(
  filename: string,
  body: (service: ProviderAccountProfiles.Interface) => Effect.Effect<A, E, ProviderAccountProfiles.Service | Database.Service>,
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

const secret = (tag: string): ProviderAccountProfiles.Secret => ({
  access: `synthetic-access-${tag}`,
  refresh: `synthetic-refresh-${tag}`,
  expires: 1_900_000_000_000,
  accountID: `synthetic-remote-${tag}`,
})

test("reauthentication preserves established remote identity and rejects both revision race directions", async () => {
  await using tmp = await tmpdir()
  await run(path.join(tmp.path, "identity-cas.db"), (service) =>
    Effect.gen(function* () {
      const account = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Identity continuity",
        remoteID: "remote-stable",
        credential: secret("initial"),
      })

      const changed = yield* Effect.exit(
        service.reauthenticate({
          id: account.id,
          revision: 0,
          value: secret("wrong-identity"),
          remoteID: "remote-replaced",
        }),
      )
      expect(changed._tag).toBe("Failure")
      if (changed._tag === "Failure")
        expect(Cause.prettyErrors(changed.cause).join("\n")).toContain("ProviderAccountProfiles.IdentityMismatchError")
      expect(yield* service.get(account.id)).toMatchObject({ remoteID: "remote-stable" })
      expect(yield* service.credential(account.id)).toEqual({ value: secret("initial"), revision: 0 })

      // Reauth wins first: a refresh holding the former credential revision may not overwrite it.
      expect(
        yield* service.reauthenticate({ id: account.id, revision: 0, value: secret("reauth-first"), remoteID: "remote-stable" }),
      ).toBe(1)
      const staleRefresh = yield* Effect.exit(
        service.compareAndSwapCredential({ id: account.id, revision: 0, value: secret("old-refresh") }),
      )
      expect(staleRefresh._tag).toBe("Failure")
      if (staleRefresh._tag === "Failure")
        expect(Cause.prettyErrors(staleRefresh.cause).join("\n")).toContain("ProviderAccountProfiles.StaleCredentialError")
      expect(yield* service.credential(account.id)).toEqual({ value: secret("reauth-first"), revision: 1 })

      // Refresh wins first: reauth's old revision cannot replace the refreshed credential.
      expect(yield* service.compareAndSwapCredential({ id: account.id, revision: 1, value: secret("refresh-first") })).toBe(2)
      const staleReauth = yield* Effect.exit(
        service.reauthenticate({ id: account.id, revision: 1, value: secret("old-reauth"), remoteID: "remote-stable" }),
      )
      expect(staleReauth._tag).toBe("Failure")
      if (staleReauth._tag === "Failure")
        expect(Cause.prettyErrors(staleReauth.cause).join("\n")).toContain("ProviderAccountProfiles.StaleCredentialError")
      expect(yield* service.credential(account.id)).toEqual({ value: secret("refresh-first"), revision: 2 })
    }),
  )
})

const waiter = (filename: string, id: string) => `
  const { Clock, Cause, Effect, Layer } = await import("effect")
  const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
  const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
  const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
  const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [[Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)]])
  const input = (async function* () {
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const item = await reader.read()
      if (item.done) return
      buf += decoder.decode(item.value, { stream: true })
      while (buf.includes("\\n")) { const at = buf.indexOf("\\n"); yield JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1) }
    }
  })()
  const command = async (type) => { const item = await input.next(); if (item.done || item.value.type !== type) throw new Error("Unexpected barrier command") }
  const send = (type, error) => console.log(JSON.stringify({ type, error }))
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* ProviderAccountProfiles.Service
    const clock = {
      currentTimeMillisUnsafe: () => Date.now(),
      currentTimeMillis: Effect.sync(() => Date.now()),
      currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1000000n,
      currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1000000n),
      sleep: () => Effect.promise(async () => { send("waiting"); await command("continue") }),
    }
    const exit = yield* Effect.exit(service.withRefresh(${JSON.stringify(id)}, Effect.succeed("entered")).pipe(Effect.provideService(Clock.Clock, clock)))
    send(exit._tag === "Success" ? "entered" : "denied", exit._tag === "Failure" ? Cause.prettyErrors(exit.cause).join("\\n") : undefined)
  }).pipe(Effect.provide(layer), Effect.scoped))
  process.exit(0)
`

function launch(filename: string, id: string) {
  const child = Bun.spawn([process.execPath, "-e", waiter(filename, id)], {
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
      if (item.done) throw new Error(`Refresh waiter exited (${await child.exited}): ${await new Response(child.stderr).text()}`)
      buf += decoder.decode(item.value, { stream: true })
    }
    const at = buf.indexOf("\n")
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    return JSON.parse(line) as { type: string; error?: string }
  }
  const send = (type: string) => child.stdin.write(`${JSON.stringify({ type })}\n`)
  return { child, next, send }
}

test("deleting an account while another process waits for its refresh lock denies the waiter", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "delete-refresh-wait.db")
  const account = await run(filename, (service) => service.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label: "Delete during refresh wait",
    credential: secret("delete-wait"),
  }))
  await run(filename, (service) => Effect.promise(async () => {
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = Effect.runPromise(service.withRefresh(account.id, Effect.promise(() => {
      ready.resolve()
      return release.promise
    })))
    await ready.promise
    const wait = launch(filename, account.id)
    try {
      expect(await wait.next()).toEqual({ type: "waiting" })
      await Effect.runPromise(service.remove(account.id))
      release.resolve()
      await held
      await wait.send("continue")
      let denied = await wait.next()
      while (denied.type === "waiting") {
        await wait.send("continue")
        denied = await wait.next()
      }
      expect(denied.type).toBe("denied")
      expect(denied.error).toContain("ProviderAccountProfiles.AccountUnavailableError")
      expect(await wait.child.exited).toBe(0)
    } finally {
      release.resolve()
      if (wait.child.exitCode === null) wait.child.kill(9)
      await wait.child.exited
    }
  }))
}, 30_000)

const storeWorker = (filename: string, tag: "A" | "B") => `
  const { Cause, Effect, Layer } = await import("effect")
  const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
  const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
  const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
  const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [[Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)]])
  const input = (async function* () {
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const item = await reader.read()
      if (item.done) return
      buf += decoder.decode(item.value, { stream: true })
      while (buf.includes("\\n")) { const at = buf.indexOf("\\n"); yield JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1) }
    }
  })()
  const command = async () => { const item = await input.next(); if (item.done) throw new Error("Store barrier closed"); return item.value }
  const send = (value) => console.log(JSON.stringify(value))
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* ProviderAccountProfiles.Service
    const own = yield* service.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Same local account label",
      credential: { access: "synthetic-store-${tag}-access", refresh: "synthetic-store-${tag}-refresh", expires: 1900000000000 },
    })
    send({ type: "created", id: own.id, label: own.label })
    const cmd = yield* Effect.promise(command)
    if (cmd.type !== "inspect") throw new Error("Expected store inspection command")
    if (${JSON.stringify(tag)} === "A") {
      const credential = yield* service.credential(own.id)
      send({ type: "checked", id: own.id, credential: credential?.value.access })
      return
    }
    const foreign = yield* service.get(cmd.id)
    const credential = yield* service.credential(cmd.id)
    let foreignCalled = false
    const denied = yield* Effect.exit(service.dispatch(cmd.id, () => { foreignCalled = true; return Promise.resolve("unexpected") }))
    let ownCalled = false
    const started = yield* service.dispatch(own.id, (value, revision) => {
      ownCalled = true
      return Promise.resolve(value.access === "synthetic-store-B-access" && revision === 0 ? "own-dispatched" : "wrong-own-credential")
    })
    const result = yield* Effect.promise(() => started.response)
    const after = yield* service.credential(own.id)
    send({
      type: "checked",
      id: own.id,
      label: own.label,
      foreignMissing: foreign === undefined,
      foreignCredentialMissing: credential === undefined,
      foreignDispatchDenied: denied._tag === "Failure",
      foreignTransportCalled: foreignCalled,
      ownTransportCalled: ownCalled,
      ownCredential: after?.value.access,
      ownRevision: after?.revision,
      ownDispatch: result,
    })
  }).pipe(Effect.provide(layer), Effect.scoped))
  process.exit(0)
`

function launchStore(filename: string, tag: "A" | "B") {
  const child = Bun.spawn([process.execPath, "-e", storeWorker(filename, tag)], {
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
      if (item.done) throw new Error(`Store worker exited (${await child.exited}): ${await new Response(child.stderr).text()}`)
      buf += decoder.decode(item.value, { stream: true })
    }
    const at = buf.indexOf("\n")
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    return JSON.parse(line) as Record<string, unknown>
  }
  const send = (value: Record<string, string>) => child.stdin.write(`${JSON.stringify(value)}\n`)
  return { child, next, send }
}

test("separate SQLite stores isolate equal-label account IDs across processes", async () => {
  await using a = await tmpdir()
  await using b = await tmpdir()
  const first = launchStore(path.join(a.path, "profiles.db"), "A")
  const second = launchStore(path.join(b.path, "profiles.db"), "B")
  try {
    const [createdA, createdB] = await Promise.all([first.next(), second.next()])
    expect(createdA).toMatchObject({ type: "created", label: "Same local account label" })
    expect(createdB).toMatchObject({ type: "created", label: "Same local account label" })
    expect(createdA.id).not.toBe(createdB.id)

    await second.send({ type: "inspect", id: String(createdA.id) })
    const checkedB = await second.next()
    expect(checkedB).toMatchObject({
      type: "checked",
      id: createdB.id,
      label: "Same local account label",
      foreignMissing: true,
      foreignCredentialMissing: true,
      foreignDispatchDenied: true,
      foreignTransportCalled: false,
      ownTransportCalled: true,
      ownCredential: "synthetic-store-B-access",
      ownRevision: 0,
      ownDispatch: "own-dispatched",
    })
    expect(await second.child.exited).toBe(0)

    await first.send({ type: "inspect", id: String(createdB.id) })
    expect(await first.next()).toEqual({
      type: "checked",
      id: createdA.id,
      credential: "synthetic-store-A-access",
    })
    expect(await first.child.exited).toBe(0)
  } finally {
    for (const proc of [first, second]) if (proc.child.exitCode === null) proc.child.kill(9)
    await Promise.all([first.child.exited, second.child.exited])
  }
}, 30_000)
