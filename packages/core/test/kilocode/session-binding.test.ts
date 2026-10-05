import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { tmpdir } from "../fixture/tmpdir"

function layer(filename: string) {
  return LayerNode.compile(LayerNode.group([SessionBinding.node, Database.node]), [
    [Database.node, Database.layerFromPath(filename).pipe(Layer.fresh)],
  ])
}

describe("session provider bindings", () => {
  test("persists distinct unbound, explicit legacy, and profile states in namespaced metadata", () => {
    const metadata = SessionBinding.set(
      { kilocode: { unrelated: true }, keep: "value" },
      {
        version: 1,
        providers: {
          openai: { mode: "unbound", reason: "profile-required" },
          anthropic: { mode: "legacy", authMode: "api-key", source: "explicit" },
          migrated: { mode: "legacy", authMode: "oauth", source: "migration", accountID: "remote-account-1" },
          codex: { mode: "profile", profileID: "pacc_test", authMode: "chatgpt-oauth", source: "default" },
        },
      },
    )

    expect(SessionBinding.get(metadata)).toEqual({
      version: 1,
      providers: {
        openai: { mode: "unbound", reason: "profile-required" },
        anthropic: { mode: "legacy", authMode: "api-key", source: "explicit" },
        migrated: { mode: "legacy", authMode: "oauth", source: "migration", accountID: "remote-account-1" },
        codex: { mode: "profile", profileID: "pacc_test", authMode: "chatgpt-oauth", source: "default" },
      },
    })
    expect(metadata).toMatchObject({ keep: "value", kilocode: { unrelated: true } })
    expect(SessionBinding.get(undefined)).toBeUndefined()
  })

  test("preserves inherited bindings and prevents generic metadata writes from erasing them", () => {
    const source = SessionBinding.set({ kilocode: { root: "kept" } }, {
      version: 1,
      providers: { openai: { mode: "profile", profileID: "pacc_parent", authMode: "chatgpt-oauth", source: "default" } },
    })
    const inherited = SessionBinding.copy(source)
    expect(SessionBinding.get(inherited)?.providers.openai).toEqual(SessionBinding.get(source)?.providers.openai)
    expect(SessionBinding.get(SessionBinding.protect(source, { title: "updated", kilocode: { root: "updated" } }))?.providers.openai)
      .toEqual(SessionBinding.get(source)?.providers.openai)
    expect(SessionBinding.get(SessionBinding.protect(source, { title: "updated" }))?.providers.openai)
      .toEqual(SessionBinding.get(source)?.providers.openai)
  })

  test("allows repair only after the prior profile is missing and confirmed", () => {
    const current: SessionBinding.Info = {
      version: 1,
      providers: {
        openai: { mode: "profile", profileID: "pacc_old", authMode: "chatgpt-oauth", source: "default" },
      },
    }
    const next: SessionBinding.Entry = {
      mode: "profile",
      profileID: "pacc_next",
      authMode: "chatgpt-oauth",
      source: "repair",
    }

    expect(() => SessionBinding.replace({ current: undefined, provider: "openai", entry: next, available: true })).toThrow(
      "Provider binding must be explicitly unbound before assignment",
    )
    expect(
      SessionBinding.replace({
        current: { version: 1, providers: { openai: { mode: "unbound", reason: "profile-required" } } },
        provider: "openai",
        entry: next,
        available: true,
      }).providers.openai,
    ).toEqual(next)

    expect(() => SessionBinding.replace({ current, provider: "openai", entry: next, available: true })).toThrow(
      "A healthy session provider binding cannot be replaced",
    )
    expect(() => SessionBinding.replace({
      current,
      provider: "openai",
      entry: { ...next, profileID: "pacc_old" },
      available: true,
      confirmRepair: true,
    })).toThrow("A healthy session provider binding cannot be replaced")
    expect(() => SessionBinding.replace({ current, provider: "openai", entry: next, available: true, priorAvailable: false })).toThrow(
      "requires confirmation",
    )
    expect(
      SessionBinding.replace({
        current,
        provider: "openai",
        entry: next,
        available: true,
        priorAvailable: false,
        confirmRepair: true,
      }).providers.openai,
    ).toEqual(next)
    const legacy: SessionBinding.Info = {
      version: 1,
      providers: { openai: { mode: "legacy", authMode: "api-key", source: "explicit", accountID: "legacy-1" } },
    }
    expect(() => SessionBinding.replace({ current: legacy, provider: "openai", entry: next, available: true })).toThrow(
      "An explicit legacy session binding cannot be replaced",
    )
    expect(() => SessionBinding.replace({
      current: legacy,
      provider: "openai",
      entry: next,
      available: true,
      confirmRepair: true,
    })).toThrow(
      "An explicit legacy session binding cannot be replaced",
    )
  })

  test("holds turn leases through work and refuses concurrent binding mutations", async () => {
    await using dir = await tmpdir()
    const db = path.join(dir.path, "bindings.db")
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionBinding.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const work = service.turn("ses_turn_test", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        const fiber = yield* work.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const exit = yield* Effect.exit(service.exclusive("ses_turn_test", Effect.void))
        expect(exit._tag).toBe("Failure")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
        yield* service.exclusive("ses_turn_test", Effect.void)
      }).pipe(Effect.provide(layer(db)), Effect.scoped),
    )
  })

  test("a second process cannot mutate a session while the turn lease is live", async () => {
    await using dir = await tmpdir()
    const db = path.join(dir.path, "bindings.db")
    const ready = path.join(dir.path, "ready")
    const gate = path.join(dir.path, "release")
    const result = path.join(dir.path, "result")
    const source = `
      import { Effect, Layer } from "effect"
      import { Database } from "@opencode-ai/core/database/database"
      import { LayerNode } from "@opencode-ai/core/effect/layer-node"
      import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
      const db = ${JSON.stringify(db)}
      const built = LayerNode.compile(LayerNode.group([SessionBinding.node, Database.node]), [[Database.node, Database.layerFromPath(db).pipe(Layer.fresh)]])
      const out = await Effect.runPromise(Effect.gen(function* () {
        const service = yield* SessionBinding.Service
        return yield* Effect.exit(service.exclusive("ses_process_test", Effect.void))
      }).pipe(Effect.provide(built), Effect.scoped))
      await Bun.write(${JSON.stringify(result)}, out._tag === "Failure" ? "blocked" : "acquired")
      await Bun.write(${JSON.stringify(ready)}, "done")
      await Bun.file(${JSON.stringify(gate)}).exists().then(async (ok) => { while (!ok) { await Bun.sleep(5); if (await Bun.file(${JSON.stringify(gate)}).exists()) break } })
    `
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionBinding.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const fiber = yield* service.turn(
          "ses_process_test",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const child = Bun.spawn([process.execPath, "-e", source], {
          cwd: path.resolve(import.meta.dir, "../.."),
          stdout: "pipe",
          stderr: "pipe",
        })
        const deadline = Date.now() + 15_000
        while (!(yield* Effect.promise(() => Bun.file(ready).exists()))) {
          if (child.exitCode !== null || Date.now() > deadline) return yield* Effect.die(new Error("session lock subprocess did not start"))
          yield* Effect.sleep("10 millis")
        }
        expect(yield* Effect.promise(() => Bun.file(result).text())).toBe("blocked")
        yield* Effect.promise(() => Bun.write(gate, "continue"))
        const code = yield* Effect.promise(() => child.exited)
        expect(code).toBe(0)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layer(db)), Effect.scoped),
    )
  })
})
