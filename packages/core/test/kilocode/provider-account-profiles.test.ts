import { expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SecretTable } from "@opencode-ai/core/kilocode/provider-account-profiles/sql"
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
    const deadline = Date.now() + 15_000
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
