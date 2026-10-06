import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Credential } from "@opencode-ai/core/credential"
import { Global } from "@opencode-ai/core/global"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { tmpdir } from "../fixture/tmpdir"

function layer(dir: string) {
  return LayerNode.compile(LayerNode.group([ProviderAccountProfiles.activation, Credential.node]), [
    [Database.node, Database.layerFromPath(path.join(dir, "profiles.db")).pipe(Layer.fresh)],
    [Global.node, Global.layerWith({ data: dir })],
  ])
}

test("qualification: startup imports a real legacy ChatGPT auth.json exactly once when enabled", async () => {
  await using tmp = await tmpdir()
  const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  const content = process.env.KILO_AUTH_CONTENT
  delete process.env.KILO_AUTH_CONTENT
  const file = path.join(tmp.path, "auth.json")
  await Bun.write(
    file,
    JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "qualification-refresh-1",
        access: "qualification-access-1",
        expires: 1_900_000_000_000,
        accountId: "qualification-remote-1",
      },
    }),
  )
  try {
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
    await Effect.runPromise(Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      yield* profiles.list("openai", "chatgpt-oauth")
    }).pipe(Effect.provide(layer(tmp.path)), Effect.scoped))

    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    const first = await Effect.runPromise(Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const list = yield* profiles.list("openai", "chatgpt-oauth")
      return {
        list,
        imported: yield* profiles.imported(),
        defaultID: yield* profiles.getDefault("openai", "chatgpt-oauth"),
        credential: list[0] ? yield* profiles.credential(list[0].id) : undefined,
      }
    }).pipe(Effect.provide(layer(tmp.path)), Effect.scoped))
    expect(first.list).toHaveLength(1)
    expect(first.imported).toMatchObject({ completed: true, accountID: first.list[0]?.id })
    expect(first.defaultID).toBe(first.list[0]?.id)
    expect(JSON.stringify(first.list)).not.toContain("qualification-access-1")
    expect(JSON.stringify(first.list)).not.toContain("qualification-refresh-1")
    const stored = first.credential
    expect(stored?.value).toMatchObject({
      access: "qualification-access-1",
      refresh: "qualification-refresh-1",
      accountID: "qualification-remote-1",
    })

    const revision = await Effect.runPromise(Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      return yield* profiles.reauthenticate({
        id: first.list[0]!.id,
        revision: 0,
        remoteID: "qualification-remote-1",
        value: {
          access: "qualification-db-reauth-access",
          refresh: "qualification-db-reauth-refresh",
          expires: 1_900_000_000_002,
          accountID: "qualification-remote-1",
        },
      })
    }).pipe(Effect.provide(layer(tmp.path)), Effect.scoped))
    expect(revision).toBe(1)

    await Bun.write(
      file,
      JSON.stringify({
        openai: {
          type: "oauth",
          refresh: "qualification-refresh-rotated",
          access: "qualification-access-rotated",
          expires: 1_900_000_000_001,
          accountId: "qualification-remote-1",
        },
      }),
    )
    const restart = await Effect.runPromise(Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      return {
        list: yield* profiles.list("openai", "chatgpt-oauth"),
        imported: yield* profiles.imported(),
        credential: yield* profiles.credential(first.list[0]!.id),
      }
    }).pipe(Effect.provide(layer(tmp.path)), Effect.scoped))
    expect(restart.list).toHaveLength(1)
    expect(restart.imported).toEqual(first.imported)
    expect(restart.credential).toEqual({
      value: {
        access: "qualification-db-reauth-access",
        refresh: "qualification-db-reauth-refresh",
        expires: 1_900_000_000_002,
        accountID: "qualification-remote-1",
      },
      revision: 1,
    })
  } finally {
    if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
    if (content === undefined) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = content
  }
})
