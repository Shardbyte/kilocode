import { afterEach, describe, expect, test } from "bun:test"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { createKiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import yargs from "yargs"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { AccountsCommand } from "../../../src/kilocode/cli/cmd/accounts"
import { tmpdir } from "../../fixture/fixture"
import { Server } from "../../../src/server/server"
import { ServerAuth } from "../../../src/server/auth"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"

const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const secret = {
  access: "synthetic-cli-access",
  refresh: "synthetic-cli-refresh",
  expires: Date.now() + 60_000,
  accountID: "synthetic-cli-account",
}

const run = <A, E>(work: Effect.Effect<A, E, ProviderAccountProfiles.Service>) =>
  AppRuntime.runPromise(work)

afterEach(() => {
  if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
})

async function cli(args: string[]) {
  const parser = yargs([])
    .scriptName("kilo accounts")
    .exitProcess(false)
    .fail((_msg, err) => {
      throw err ?? new Error(_msg)
    })
  if (typeof AccountsCommand.builder !== "function") throw new Error("accounts command builder is missing")
  await AccountsCommand.builder(parser)
  await parser.parseAsync(args)
}

describe("kilo accounts CLI", () => {
  test("routes directory-scoped commands through the real server and never prints credentials", async () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    await using tmp = await tmpdir({ git: true })
    const profile = await run(
      ProviderAccountProfiles.Service.use((store) =>
        store.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "CLI synthetic",
          remoteID: "cli-remote",
          credential: secret,
        }),
      ),
    )
    const out: string[] = []
    const err: string[] = []
    const log = console.log
    const error = console.error
    console.log = (...values) => out.push(values.join(" "))
    console.error = (...values) => err.push(values.join(" "))
    try {
      await cli(["list", "--json", "--directory", tmp.path])
      await cli(["rename", profile.id, "CLI renamed", "--json", "--directory", tmp.path])
      await cli(["default", profile.id, "--json", "--directory", tmp.path])
      await cli(["auth-state", profile.id, "--json", "--directory", tmp.path])
    } finally {
      console.log = log
      console.error = error
      await run(ProviderAccountProfiles.Service.use((store) => store.remove(profile.id)))
    }

    const output = out.join("\n")
    expect(output).toContain('"label": "CLI renamed"')
    expect(output).toContain('"defaultAccountID"')
    expect(output).toContain('"state": "ready"')
    expect(output).not.toContain(secret.access)
    expect(output).not.toContain(secret.refresh)
    expect(err).toEqual([])
  })

  test("surfaces safe backend errors and does not report a failed mutation as success", async () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const out: string[] = []
    const write = process.stdout.write
    const log = console.log
    console.log = (...values) => out.push(values.join(" "))
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await expect(
        cli(["default", "missing-provider-account", "--json", "--directory", process.cwd()]),
      ).rejects.toThrow("Provider account or session was not found")
    } finally {
      process.stdout.write = write
      console.log = log
    }
    expect(out).toEqual([])
    expect(out.join("\n")).not.toContain(secret.access)
  })

  test("assigns only unbound slots and confirms unavailable repair without switching healthy or legacy bindings", async () => {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    await using tmp = await tmpdir({ git: true })
    const first = await run(
      ProviderAccountProfiles.Service.use((store) =>
        store.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "CLI recovery first",
          credential: secret,
        }),
      ),
    )
    const second = await run(
      ProviderAccountProfiles.Service.use((store) =>
        store.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "CLI recovery second",
          credential: { ...secret, accountID: "synthetic-cli-second" },
        }),
      ),
    )
    await run(ProviderAccountProfiles.Service.use((store) => store.clearDefault("openai", "chatgpt-oauth")))
    const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const sdk = createKiloClient({ baseUrl: `http://${server.hostname}:${server.port}`, headers: ServerAuth.headers() })
    const create = async (parentID?: string) => {
      const result = await sdk.session.create({ directory: tmp.path, parentID })
      if (!result.data) throw new Error("Session creation failed")
      return result.data
    }
    const out: string[] = []
    const log = console.log
    console.log = (...values) => out.push(values.join(" "))
    const flags = ["--json", "--directory", tmp.path]
    const gate = Promise.withResolvers<void>()
    try {
      const session = await create()
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
      const legacy = await create()
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      await cli(["session", session.id, ...flags])
      expect(JSON.parse(out.at(-1) ?? "null")).toMatchObject({ mode: "unbound" })
      const ready = Promise.withResolvers<void>()
      const held = run(
        SessionBinding.Service.use((store) =>
          store.turn(
            session.id,
            Effect.promise(() => {
              ready.resolve()
              return gate.promise
            }),
          ),
        ).pipe(Effect.provide(AppNodeBuilder.build(SessionBinding.node))),
      )
      await ready.promise
      await expect(cli(["assign", session.id, first.id, ...flags])).rejects.toThrow("a turn may be running")
      gate.resolve()
      await held
      await cli(["assign", session.id, first.id, ...flags])
      expect(JSON.parse(out.at(-1) ?? "null")).toMatchObject({
        providers: { openai: { mode: "profile", profileID: first.id } },
      })
      const child = await create(session.id)
      await expect(cli(["assign", session.id, second.id, "--repair", "--yes", ...flags])).rejects.toThrow(
        "not eligible",
      )
      await expect(cli(["assign", legacy.id, second.id, "--repair", "--yes", ...flags])).rejects.toThrow("not eligible")
      await run(
        ProviderAccountProfiles.Service.use((store) =>
          Effect.gen(function* () {
            const credential = yield* store.credential(first.id)
            if (!credential) throw new Error("Test credential is missing")
            yield* store.compareAndSwapCredential({
              id: first.id,
              revision: credential.revision,
              value: { ...secret, expires: 0 },
            })
          }),
        ),
      )
      await expect(cli(["assign", session.id, second.id, "--repair", "--yes", ...flags])).rejects.toThrow(
        "not eligible",
      )
      await cli(["remove", first.id, "--yes", ...flags])
      await expect(cli(["assign", session.id, second.id, ...flags])).rejects.toThrow("--repair")
      await cli(["assign", session.id, second.id, "--repair", "--yes", ...flags])
      expect(JSON.parse(out.at(-1) ?? "null")).toMatchObject({
        providers: { openai: { mode: "profile", profileID: second.id, source: "repair" } },
      })
      await cli(["session", child.id, ...flags])
      expect(JSON.parse(out.at(-1) ?? "null")).toMatchObject({ mode: "profile", profileID: first.id })
      await cli(["usage", first.id, ...flags])
      expect(JSON.parse(out.at(-1) ?? "null")).toMatchObject({
        accountID: first.id,
        snapshot: { fetchState: "unavailable" },
      })
      await cli(["refresh", first.id, ...flags])
      expect(JSON.parse(out.at(-1) ?? "null")).toMatchObject({
        accountID: first.id,
        snapshot: { fetchState: "unavailable" },
      })
      expect(out.join("\n")).not.toContain(secret.access)
      expect(out.join("\n")).not.toContain(secret.refresh)
    } finally {
      gate.resolve()
      console.log = log
      await server.stop(true)
      await run(
        ProviderAccountProfiles.Service.use((store) =>
          Effect.gen(function* () {
            if (yield* store.get(first.id)) yield* store.remove(first.id)
            yield* store.remove(second.id)
          }),
        ),
      )
    }
  }, 20_000)
})
