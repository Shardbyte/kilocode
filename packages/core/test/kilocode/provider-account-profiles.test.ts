import { expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SecretTable } from "@opencode-ai/core/kilocode/provider-account-profiles/sql"
import { importStoredLegacy } from "@opencode-ai/core/kilocode/provider-account-profiles/lifecycle"
import { tmpdir } from "../fixture/tmpdir"

const oauth = (tag: string): ProviderAccountProfiles.Secret => ({
  access: `recognizable-access-${tag}`,
  refresh: `recognizable-refresh-${tag}`,
  expires: 1_900_000_000_000,
  accountID: `remote-account-${tag}`,
})

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

async function race(dir: string, gate: string, scripts: { name: string; code: string }[]) {
  const children = scripts.map((script) =>
    Bun.spawn([process.execPath, "-e", script.code], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  try {
    const deadline = Date.now() + 30_000
    while (
      !(await Promise.all(scripts.map((script) => Bun.file(path.join(dir, `${script.name}.ready`)).exists()))).every(
        Boolean,
      )
    ) {
      if (children.some((child) => child.exitCode !== null) || Date.now() > deadline) {
        throw new Error("Provider profile processes failed before reaching the creation barrier")
      }
      await Bun.sleep(5)
    }
    await Bun.write(gate, "go")
    return await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        out: await new Response(child.stdout).text(),
        err: await new Response(child.stderr).text(),
      })),
    )
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill(9)
    await Promise.all(children.map((child) => child.exited))
  }
}

test("provider account profiles persist separate metadata and CAS credentials", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "profiles.db")
  const { a, b } = await run(filename, (service) =>
    Effect.gen(function* () {
      const a = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "  Work  ",
        credential: oauth("A"),
      })
      expect(a.label).toBe("Work")
      expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBe(a.id)
      const b = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Personal",
        remoteID: "remote-B",
        credential: oauth("B"),
      })
      expect(b.id).not.toBe(a.id)
      expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBe(a.id)
      expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(2)
      expect(JSON.stringify(yield* service.list("openai", "chatgpt-oauth"))).not.toContain("recognizable-")
      expect(yield* service.get(a.id)).not.toHaveProperty("credential")
      expect(yield* service.credential(a.id)).toEqual({ value: oauth("A"), revision: 0 })
      expect(yield* service.credential(b.id)).toEqual({ value: oauth("B"), revision: 0 })

      const duplicateLabel = yield* Effect.exit(
        service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "work",
          credential: oauth("duplicate-label"),
        }),
      )
      expect(duplicateLabel._tag).toBe("Failure")
      if (duplicateLabel._tag === "Failure") {
        const error = Cause.prettyErrors(duplicateLabel.cause).join("\n")
        expect(error).not.toContain("recognizable-access-duplicate-label")
        expect(error).not.toContain("recognizable-refresh-duplicate-label")
      }
      const duplicateRemote = yield* Effect.exit(
        service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Remote duplicate",
          remoteID: "remote-B",
          credential: oauth("duplicate-remote"),
        }),
      )
      expect(duplicateRemote._tag).toBe("Failure")
      if (duplicateRemote._tag === "Failure") {
        const error = Cause.prettyErrors(duplicateRemote.cause).join("\n")
        expect(error).not.toContain("recognizable-access-duplicate-remote")
        expect(error).not.toContain("recognizable-refresh-duplicate-remote")
      }
      expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(2)
      expect(
        (yield* service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "No remote identity",
          credential: oauth("null-remote"),
        })).remoteID,
      ).toBeNull()
      const cafe = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Café",
        credential: oauth("cafe"),
      })
      const normalizedLabel = yield* Effect.exit(
        service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Cafe\u0301",
          credential: oauth("normalized-label"),
        }),
      )
      expect(normalizedLabel._tag).toBe("Failure")
      expect(yield* service.get(cafe.id)).toMatchObject({ label: "Café" })
      const blankLabel = yield* Effect.exit(
        service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: " \t ",
          credential: oauth("blank-label"),
        }),
      )
      expect(blankLabel._tag).toBe("Failure")
      expect(
        (yield* service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Another no-identity account",
          credential: oauth("null-remote-2"),
        })).remoteID,
      ).toBeNull()

      expect(yield* service.compareAndSwapCredential({ id: a.id, revision: 0, value: oauth("A2") })).toBe(1)
      expect(yield* service.compareAndSwapCredential({ id: b.id, revision: 0, value: oauth("B2") })).toBe(1)
      expect(yield* service.credential(a.id)).toEqual({ value: oauth("A2"), revision: 1 })
      expect(yield* service.credential(b.id)).toEqual({ value: oauth("B2"), revision: 1 })
      const stale = yield* Effect.exit(
        service.compareAndSwapCredential({ id: a.id, revision: 0, value: oauth("stale") }),
      )
      expect(stale._tag).toBe("Failure")
      if (stale._tag === "Failure") {
        expect(Cause.prettyErrors(stale.cause).join("\n")).toContain("ProviderAccountProfiles.StaleCredentialError")
        expect(Cause.prettyErrors(stale.cause).join("\n")).not.toContain(oauth("stale").access)
        expect(Cause.prettyErrors(stale.cause).join("\n")).not.toContain(oauth("stale").refresh)
      }
      expect(yield* service.credential(a.id)).toEqual({ value: oauth("A2"), revision: 1 })

      yield* service.selectDefault("openai", "chatgpt-oauth", b.id)
      expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBe(b.id)
      const wrongContext = yield* Effect.exit(service.selectDefault("anthropic", "chatgpt-oauth", b.id))
      expect(wrongContext._tag).toBe("Failure")

      const { db } = yield* Database.Service
      const invalidDefault = yield* Effect.exit(
        db.run(
          sql`INSERT INTO kilo_provider_account_default (provider, auth_mode, account_id) VALUES ('anthropic', 'chatgpt-oauth', ${b.id})`,
        ),
      )
      expect(invalidDefault._tag).toBe("Failure")
      const invalidAuthModeDefault = yield* Effect.exit(
        db.run(
          sql`INSERT INTO kilo_provider_account_default (provider, auth_mode, account_id) VALUES ('openai', 'future-auth-mode', ${b.id})`,
        ),
      )
      expect(invalidAuthModeDefault._tag).toBe("Failure")

      yield* db.run(
        sql`CREATE TRIGGER reject_profile_credential_insert BEFORE INSERT ON kilo_provider_account_credential BEGIN SELECT RAISE(ABORT, 'synthetic credential insert failure'); END`,
      )
      const insertFailure = yield* Effect.exit(
        service.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Failure after metadata insert",
          credential: oauth("db-insert-failure"),
        }),
      )
      expect(insertFailure._tag).toBe("Failure")
      if (insertFailure._tag === "Failure") {
        const error = Cause.prettyErrors(insertFailure.cause).join("\n")
        expect(error).not.toContain("recognizable-access-db-insert-failure")
        expect(error).not.toContain("recognizable-refresh-db-insert-failure")
      }
      expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(5)
      yield* db.run(sql`DROP TRIGGER reject_profile_credential_insert`)

      yield* db.run(
        sql`CREATE TRIGGER reject_profile_credential_update BEFORE UPDATE ON kilo_provider_account_credential BEGIN SELECT RAISE(ABORT, 'synthetic credential update failure'); END`,
      )
      const updateFailure = yield* Effect.exit(
        service.compareAndSwapCredential({ id: b.id, revision: 1, value: oauth("db-update-failure") }),
      )
      expect(updateFailure._tag).toBe("Failure")
      if (updateFailure._tag === "Failure") {
        const error = Cause.prettyErrors(updateFailure.cause).join("\n")
        expect(error).not.toContain("recognizable-access-db-update-failure")
        expect(error).not.toContain("recognizable-refresh-db-update-failure")
      }
      expect(yield* service.credential(b.id)).toEqual({ value: oauth("B2"), revision: 1 })
      yield* db.run(sql`DROP TRIGGER reject_profile_credential_update`)

      const invalidCredential = yield* Effect.exit(
        db
          .insert(SecretTable)
          .values({ account_id: "missing-profile", value: oauth("orphan"), revision: 0, time_updated: Date.now() })
          .run(),
      )
      expect(invalidCredential._tag).toBe("Failure")
      return { a, b }
    }),
  )

  await run(filename, (service) =>
    Effect.gen(function* () {
      expect(yield* service.get(a.id)).toMatchObject({ id: a.id, label: "Work" })
      expect(yield* service.credential(a.id)).toEqual({ value: oauth("A2"), revision: 1 })
      expect(yield* service.credential(b.id)).toEqual({ value: oauth("B2"), revision: 1 })
      expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBe(b.id)
    }),
  )

  await run(filename, (service) =>
    Effect.gen(function* () {
      yield* service.clearDefault("openai", "chatgpt-oauth")
      yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "After clear",
        credential: oauth("after-clear"),
      })
      expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBeUndefined()
    }),
  )

  await run(filename, (service) =>
    Effect.gen(function* () {
      expect(yield* service.credential(a.id)).toEqual({ value: oauth("A2"), revision: 1 })
      expect(yield* service.credential(b.id)).toEqual({ value: oauth("B2"), revision: 1 })
      expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBeUndefined()
    }),
  )
})

test("profile dispatch releases SQLite coordination before the response settles", async () => {
  await using tmp = await tmpdir()
  const result = await run(path.join(tmp.path, "dispatch.db"), (service) =>
    Effect.gen(function* () {
      const account = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Dispatch",
        credential: oauth("dispatch"),
      })
      const response = Promise.withResolvers<string>()
      const started = yield* service.dispatch(account.id, (secret, revision) => {
        expect(secret.access).toBe(oauth("dispatch").access)
        expect(revision).toBe(0)
        return response.promise
      })
      yield* service.remove(account.id)
      expect(yield* service.get(account.id)).toBeUndefined()
      response.resolve("sent")
      return started.response
    }),
  )
  expect(result).toBe("sent")
})

test("reauthentication enforces revision and strong identity continuity", async () => {
  await using tmp = await tmpdir()
  await run(path.join(tmp.path, "reauth.db"), (service) =>
    Effect.gen(function* () {
      const first = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Work",
        remoteID: "remote-work",
        credential: oauth("before"),
      })
      const second = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Personal",
        remoteID: "remote-personal",
        credential: oauth("personal"),
      })
      const unbound = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "Unbound identity",
        credential: oauth("unbound"),
      })
      const mismatch = yield* Effect.exit(
        service.reauthenticate({
          id: first.id,
          revision: 0,
          value: oauth("wrong-account"),
          remoteID: "remote-personal",
        }),
      )
      expect(mismatch._tag).toBe("Failure")
      if (mismatch._tag === "Failure") {
        expect(Cause.prettyErrors(mismatch.cause).join("\n")).toContain("ProviderAccountProfiles.IdentityMismatchError")
      }
      const missing = yield* Effect.exit(
        service.reauthenticate({ id: first.id, revision: 0, value: oauth("missing-identity") }),
      )
      expect(missing._tag).toBe("Failure")
      if (missing._tag === "Failure") {
        expect(Cause.prettyErrors(missing.cause).join("\n")).toContain("ProviderAccountProfiles.IdentityMismatchError")
      }
      expect(yield* service.credential(first.id)).toEqual({ value: oauth("before"), revision: 0 })
      const duplicate = yield* Effect.exit(
        service.reauthenticate({
          id: unbound.id,
          revision: 0,
          value: oauth("duplicate-account"),
          remoteID: "remote-personal",
        }),
      )
      expect(duplicate._tag).toBe("Failure")
      if (duplicate._tag === "Failure") {
        expect(Cause.prettyErrors(duplicate.cause).join("\n")).toContain(
          "ProviderAccountProfiles.DuplicateRemoteIdentityError",
        )
      }
      const stale = yield* Effect.exit(
        service.reauthenticate({
          id: first.id,
          revision: 3,
          value: oauth("stale"),
          remoteID: "remote-work",
        }),
      )
      expect(stale._tag).toBe("Failure")
      expect(yield* service.credential(first.id)).toEqual({ value: oauth("before"), revision: 0 })
      expect(
        yield* service.reauthenticate({
          id: first.id,
          revision: 0,
          value: oauth("after"),
          remoteID: "remote-work",
        }),
      ).toBe(1)
      expect(yield* service.credential(first.id)).toEqual({ value: oauth("after"), revision: 1 })
      expect(yield* service.get(second.id)).toMatchObject({ remoteID: "remote-personal" })
    }),
  )
})

test("guarded legacy import records completion atomically and never resurrects a removed account", async () => {
  await using tmp = await tmpdir()
  const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  try {
    const filename = path.join(tmp.path, "import.db")
    const id = await run(filename, (service) =>
      Effect.gen(function* () {
        const imported = yield* service.importLegacy({ credential: oauth("legacy"), remoteID: "remote-legacy" })
        expect(imported.imported).toBe(true)
        expect(imported.accountID).toBeDefined()
        expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBe(imported.accountID)
        yield* service.remove(imported.accountID!)
        expect(yield* service.importLegacy({ credential: oauth("new-legacy"), remoteID: "remote-new" })).toEqual({
          imported: false,
          accountID: imported.accountID,
        })
        expect(yield* service.get(imported.accountID!)).toBeUndefined()
        expect(yield* service.imported()).toEqual({ completed: true, accountID: imported.accountID })
        return imported.accountID
      }),
    )
    await run(filename, (service) =>
      Effect.gen(function* () {
        expect(yield* service.importLegacy({ credential: oauth("restart"), remoteID: "remote-restart" })).toEqual({
          imported: false,
          accountID: id,
        })
        expect(yield* service.list("openai", "chatgpt-oauth")).toEqual([])
        expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBeUndefined()
        expect(yield* service.imported()).toEqual({ completed: true, accountID: id })
      }),
    )
  } finally {
    if (before === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
  }
})

test("injected credentials do not enter stored profile import", async () => {
  const profileFlag = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  const authContent = process.env.KILO_AUTH_CONTENT
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  process.env.KILO_AUTH_CONTENT = "{}"
  let imported = false
  let listed = false
  try {
    await Effect.runPromise(
      importStoredLegacy(
        {
          importLegacy: () => {
            imported = true
            return Effect.succeed({ imported: false })
          },
        },
        {
          list: () => {
            listed = true
            return Effect.succeed([])
          },
        },
      ),
    )
    expect(listed).toBe(false)
    expect(imported).toBe(false)
  } finally {
    if (profileFlag === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = profileFlag
    if (authContent === undefined) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = authContent
  }
})

test("failed legacy profile write leaves neither a profile nor a completion marker", async () => {
  await using tmp = await tmpdir()
  const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  try {
    await run(path.join(tmp.path, "import-failure.db"), (service) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`CREATE TRIGGER reject_legacy_profile_secret BEFORE INSERT ON kilo_provider_account_credential BEGIN SELECT RAISE(ABORT, 'sentinel-secret-import-failure'); END`,
        )
        const failed = yield* Effect.exit(
          service.importLegacy({ credential: oauth("rollback"), remoteID: "remote-rollback" }),
        )
        expect(failed._tag).toBe("Failure")
        if (failed._tag === "Failure") {
          const errors = Cause.prettyErrors(failed.cause).join("\n")
          expect(errors).not.toContain(oauth("rollback").access)
          expect(errors).not.toContain(oauth("rollback").refresh)
        }
        expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(0)
        expect(yield* service.imported()).toEqual({ completed: false })
      }),
    )
  } finally {
    if (before === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
  }
})

test("failed durable marker insert rolls back imported metadata, credential, and default", async () => {
  await using tmp = await tmpdir()
  const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  try {
    await run(path.join(tmp.path, "marker-failure.db"), (service) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`CREATE TRIGGER reject_import_marker BEFORE INSERT ON kilo_provider_account_import BEGIN SELECT RAISE(ABORT, 'marker failure'); END`,
        )
        const failed = yield* Effect.exit(
          service.importLegacy({ credential: oauth("marker-failure"), remoteID: "remote-marker-failure" }),
        )
        expect(failed._tag).toBe("Failure")
        expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(0)
        expect(yield* service.getDefault("openai", "chatgpt-oauth")).toBeUndefined()
        expect(yield* service.imported()).toEqual({ completed: false })
      }),
    )
  } finally {
    if (before === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
  }
})

test("concurrent independent importers commit one account and survive process restart", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "import-race.db")
  const dir = tmp.path
  const gate = path.join(dir, "import.go")
  const ready = (name: string) => path.join(dir, `${name}.ready`)
  const code = (name: string, tag: string) => `
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const { Effect, Layer } = await import("effect")
    const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
    const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
    const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
    const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [[Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)]])
    await Bun.write(${JSON.stringify(ready(name))}, "ready")
    while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(5)
    const result = await Effect.runPromise(Effect.gen(function* () { const service = yield* ProviderAccountProfiles.Service; return yield* service.importLegacy({ credential: { access: "a-${tag}", refresh: "r-${tag}", expires: 1900000000000, accountID: "remote-race" }, remoteID: "remote-race" }) }).pipe(Effect.provide(layer), Effect.scoped))
    console.log(JSON.stringify(result))
  `
  await run(filename, () => Effect.void)
  const before = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  try {
    const children = await race(dir, gate, [
      { name: "import-a", code: code("import-a", "a") },
      { name: "import-b", code: code("import-b", "b") },
    ])
    expect(children.every((child) => child.code === 0)).toBe(true)
    const results = children.map((child) => {
      const item: unknown = JSON.parse(child.out)
      if (typeof item !== "object" || item === null || !("imported" in item) || typeof item.imported !== "boolean")
        throw new Error("Provider profile import subprocess returned an invalid result")
      return {
        imported: item.imported,
        ...("accountID" in item && typeof item.accountID === "string" ? { accountID: item.accountID } : {}),
      }
    })
    expect(results.filter((item) => item.imported)).toHaveLength(1)
    expect(results[0]?.accountID).toBe(results[1]?.accountID)
    await run(filename, (service) =>
      Effect.gen(function* () {
        expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(1)
        expect(yield* service.imported()).toEqual({ completed: true, accountID: results[0]?.accountID })
      }),
    )
  } finally {
    if (before === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = before
  }
}, 30_000)

test("refresh locks are account-scoped: same account serializes while another account proceeds", async () => {
  await using tmp = await tmpdir()
  await run(path.join(tmp.path, "refresh.db"), (service) =>
    Effect.gen(function* () {
      const a = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "A",
        credential: oauth("refresh-a"),
      })
      const b = yield* service.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "B",
        credential: oauth("refresh-b"),
      })
      const hold = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<void>()
      const first = Effect.runPromise(
        service.withRefresh(
          a.id,
          Effect.promise(() => {
            ready.resolve()
            return hold.promise
          }),
        ),
      )
      yield* Effect.promise(() => ready.promise)
      let count = 0
      const second = Effect.runPromise(
        service.withRefresh(
          a.id,
          Effect.sync(() => ++count),
        ),
      )
      expect(yield* service.withRefresh(b.id, Effect.succeed("independent"))).toBe("independent")
      hold.resolve()
      yield* Effect.promise(() => first)
      expect(yield* Effect.promise(() => second)).toBe(1)
      expect(count).toBe(1)
    }),
  )
})

test("concurrent processes create accounts in one shared database", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "concurrent.db")
  const gate = path.join(tmp.path, "release")
  await run(filename, () => Effect.void)
  const scripts = ["Process A", "Process B"].map((label) => ({
    name: label,
    code: `
      const { Effect, Layer } = await import("effect")
      const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
      const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
      const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
      const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [
        [Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)],
      ])
      const id = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ProviderAccountProfiles.Service
          yield* Effect.promise(async () => {
            await Bun.write(${JSON.stringify(`${tmp.path}/${label}.ready`)}, "ready")
            while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(5)
          })
          return (
            yield* service.create({
              provider: "openai",
              authMode: "chatgpt-oauth",
              label: ${JSON.stringify(label)},
              remoteID: ${JSON.stringify(`remote-${label}`)},
              credential: {
                access: ${JSON.stringify(`recognizable-access-${label}`)},
                refresh: ${JSON.stringify(`recognizable-refresh-${label}`)},
                expires: 1,
              },
            })
          ).id
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
      console.log(id)
    `,
  }))
  const results = await race(tmp.path, gate, scripts)
  expect(results.map((result) => result.code)).toEqual([0, 0])
  expect(results.map((result) => result.err)).toEqual(["", ""])
  const accounts = results.map((result, index) => {
    const name = scripts.at(index)?.name
    const id = result.out.trim()
    if (!id || name == null) throw new Error("Provider profile process output is malformed")
    return { id, access: `recognizable-access-${name}`, refresh: `recognizable-refresh-${name}` }
  })
  const ids = accounts.map((account) => account.id)
  expect(new Set(ids).size).toBe(2)
  await run(filename, (service) =>
    Effect.gen(function* () {
      expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(2)
      const id = yield* service.getDefault("openai", "chatgpt-oauth")
      expect(id).toBeDefined()
      if (id) expect(ids).toContain(id)
      for (const account of accounts) {
        expect(yield* service.credential(account.id)).toEqual({
          value: { access: account.access, refresh: account.refresh, expires: 1 },
          revision: 0,
        })
      }
    }),
  )

  const collisions = ["Remote Race A", "Remote Race B"].map((label) => ({
    name: label,
    code: `
      const { Effect, Layer } = await import("effect")
      const { Database } = await import(${JSON.stringify(new URL("../../src/database/database.ts", import.meta.url).href)})
      const { LayerNode } = await import(${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).href)})
      const { ProviderAccountProfiles } = await import(${JSON.stringify(new URL("../../src/kilocode/provider-account-profiles.ts", import.meta.url).href)})
      const layer = LayerNode.compile(LayerNode.group([ProviderAccountProfiles.node, Database.node]), [
        [Database.node, Database.layerFromPath(${JSON.stringify(filename)}).pipe(Layer.fresh)],
      ])
      const result = await Effect.runPromise(
        Effect.exit(Effect.gen(function* () {
          const service = yield* ProviderAccountProfiles.Service
          yield* Effect.promise(async () => {
            await Bun.write(${JSON.stringify(`${tmp.path}/${label}.ready`)}, "ready")
            while (!(await Bun.file(${JSON.stringify(`${tmp.path}/remote-gate`)}).exists())) await Bun.sleep(5)
          })
          return yield* service.create({
            provider: "openai",
            authMode: "chatgpt-oauth",
            label: ${JSON.stringify(label)},
            remoteID: "remote-collision",
            credential: {
              access: ${JSON.stringify(`recognizable-access-${label}`)},
              refresh: ${JSON.stringify(`recognizable-refresh-${label}`)},
              expires: 1,
            },
          })
        }).pipe(Effect.provide(layer), Effect.scoped)),
      )
      console.log(result._tag === "Success" ? "CREATED" : "DUPLICATE")
    `,
  }))
  const duplicateResults = await race(tmp.path, path.join(tmp.path, "remote-gate"), collisions)
  expect(duplicateResults.map((result) => result.code)).toEqual([0, 0])
  expect(duplicateResults.map((result) => result.err)).toEqual(["", ""])
  expect(duplicateResults.map((result) => result.out.trim()).sort()).toEqual(["CREATED", "DUPLICATE"])
  await run(filename, (service) =>
    Effect.gen(function* () {
      expect(yield* service.list("openai", "chatgpt-oauth")).toHaveLength(3)
      const id = yield* service.getDefault("openai", "chatgpt-oauth")
      expect(id).toBeDefined()
      if (id) expect(ids).toContain(id)
      for (const account of accounts) {
        expect(yield* service.credential(account.id)).toEqual({
          value: { access: account.access, refresh: account.refresh, expires: 1 },
          revision: 0,
        })
      }
      expect(
        (yield* service.list("openai", "chatgpt-oauth")).filter((entry) => entry.remoteID === "remote-collision"),
      ).toHaveLength(1)
    }),
  )
}, 30_000)
