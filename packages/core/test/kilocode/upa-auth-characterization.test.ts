import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { tmpdir } from "../fixture/tmpdir"

const provider = Integration.ID.make("openai")
const legacy = (tag: string) => ({
  type: "oauth",
  access: `fixture-access-${tag}`,
  refresh: `fixture-refresh-${tag}`,
  expires: 1_900_000_000_000,
  accountId: tag,
})

function layer(dir: string) {
  return LayerNode.compile(LayerNode.group([ProviderAccountProfiles.activation, Credential.node]), [
    [Database.node, Database.layerFromPath(path.join(dir, "upa.db")).pipe(Layer.fresh)],
    [Global.node, Global.layerWith({ data: dir })],
  ]).pipe(Layer.fresh)
}

function inspect(dir: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const credentials = yield* Credential.Service
      const accounts = yield* profiles.list("openai", "chatgpt-oauth")
      return {
        accounts,
        marker: yield* profiles.imported(),
        secrets: yield* Effect.forEach(accounts, (account) => profiles.credential(account.id)),
        credentials: yield* credentials.list(provider),
      }
    }).pipe(Effect.provide(layer(dir)), Effect.scoped),
  )
}

test("UPA-0 JSON reconciliation loses headless method identity before automatic profile import", async () => {
  await using tmp = await tmpdir()
  const prior = { flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES, auth: process.env.KILO_AUTH_CONTENT }
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  delete process.env.KILO_AUTH_CONTENT
  try {
    const seed = LayerNode.compile(Credential.node, [
      [Database.node, Database.layerFromPath(path.join(tmp.path, "upa.db")).pipe(Layer.fresh)],
      [Global.node, Global.layerWith({ data: tmp.path })],
    ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: provider,
          value: Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-headless"),
            access: "fixture-headless-access",
            refresh: "fixture-headless-refresh",
            expires: 1_900_000_000_000,
          }),
        })
      }).pipe(Effect.provide(seed), Effect.scoped),
    )
    const state = await inspect(tmp.path)
    expect(state.accounts).toHaveLength(1)
    expect(state.marker).toEqual({ completed: true, accountID: state.accounts.at(0)?.id })
    expect(state.credentials.at(0)?.value).toMatchObject({ methodID: "chatgpt-browser" })
    expect(state.secrets.at(0)?.value).toMatchObject({ access: "fixture-headless-access" })
  } finally {
    if (prior.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.flag
    if (prior.auth == null) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = prior.auth
  }
})

// UPA-0 records implemented behavior, including ownership hazards; these are not proposed contracts.
test.each(["0", "1"])(
  "UPA-0 activation flag %s controls automatic import without deleting legacy JSON",
  async (flag) => {
    await using tmp = await tmpdir()
    const prior = { flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES, auth: process.env.KILO_AUTH_CONTENT }
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = flag
    delete process.env.KILO_AUTH_CONTENT
    const file = path.join(tmp.path, "auth.json")
    const data = { openai: legacy("original") }
    await Bun.write(file, JSON.stringify(data))
    try {
      const first = await inspect(tmp.path)
      expect(first.accounts).toHaveLength(flag === "1" ? 1 : 0)
      expect(first.marker.completed).toBe(flag === "1")
      expect(first.credentials).toHaveLength(1)
      expect(first.credentials.at(0)?.value).toMatchObject({ access: "fixture-access-original" })
      expect(await Bun.file(file).json()).toEqual(data)
      if (flag === "1") {
        expect(first.secrets.at(0)?.value).toMatchObject({ access: "fixture-access-original", accountID: "original" })
        expect((await inspect(tmp.path)).accounts).toEqual(first.accounts)
      }
    } finally {
      if (prior.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.flag
      if (prior.auth == null) delete process.env.KILO_AUTH_CONTENT
      else process.env.KILO_AUTH_CONTENT = prior.auth
    }
  },
)

test("UPA-0 completed empty import suppresses later OAuth reconciliation but still reconciles API keys", async () => {
  await using tmp = await tmpdir()
  const prior = { flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES, auth: process.env.KILO_AUTH_CONTENT }
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  delete process.env.KILO_AUTH_CONTENT
  const file = path.join(tmp.path, "auth.json")
  await Bun.write(file, "{}")
  try {
    expect((await inspect(tmp.path)).marker).toEqual({ completed: true })
    await Bun.write(file, JSON.stringify({ openai: legacy("late") }))
    const oauth = await inspect(tmp.path)
    expect(oauth.accounts).toEqual([])
    expect(oauth.credentials).toEqual([])
    await Bun.write(file, JSON.stringify({ openai: { type: "api", key: "fixture-key" } }))
    const key = await inspect(tmp.path)
    expect(key.accounts).toEqual([])
    expect(key.credentials.at(0)?.value).toMatchObject({ type: "key", key: "fixture-key" })
  } finally {
    if (prior.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.flag
    if (prior.auth == null) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = prior.auth
  }
})

test("UPA-0 imported lineage has independent profile revision and a retained stale legacy copy", async () => {
  await using tmp = await tmpdir()
  const prior = { flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES, auth: process.env.KILO_AUTH_CONTENT }
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
  delete process.env.KILO_AUTH_CONTENT
  const file = path.join(tmp.path, "auth.json")
  await Bun.write(file, JSON.stringify({ openai: legacy("original") }))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        const accounts = yield* profiles.list("openai", "chatgpt-oauth")
        const account = accounts.at(0)!
        yield* profiles.reauthenticate({
          id: account.id,
          revision: 0,
          remoteID: "original",
          value: {
            access: "fixture-rotated",
            refresh: "fixture-rotated-refresh",
            expires: 1_900_000_000_000,
            accountID: "original",
          },
        })
        yield* profiles.rename(account.id, "Renamed")
        expect((yield* profiles.credential(account.id))?.revision).toBe(1)
      }).pipe(Effect.provide(layer(tmp.path)), Effect.scoped),
    )
    const state = await inspect(tmp.path)
    expect(state.secrets.at(0)).toMatchObject({ revision: 1, value: { access: "fixture-rotated" } })
    expect(state.credentials.at(0)?.value).toMatchObject({ access: "fixture-access-original" })
    expect(await Bun.file(file).json()).toEqual({ openai: legacy("original") })
    await Bun.write(file, JSON.stringify({ openai: legacy("replacement") }))
    expect((await inspect(tmp.path)).credentials.at(0)?.value).toMatchObject({ access: "fixture-access-original" })
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
    expect((await inspect(tmp.path)).credentials.at(0)?.value).toMatchObject({ access: "fixture-access-replacement" })
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    expect((await inspect(tmp.path)).secrets.at(0)?.value).toMatchObject({ access: "fixture-rotated" })
  } finally {
    if (prior.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.flag
    if (prior.auth == null) delete process.env.KILO_AUTH_CONTENT
    else process.env.KILO_AUTH_CONTENT = prior.auth
  }
})
