import { expect } from "bun:test"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { eligible } from "../../../src/kilocode/provider/availability"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(ProviderAccountProfiles.node, [
    [Database.node, Database.layerFromPath(":memory:").pipe(Layer.fresh)],
  ]),
)

it.live("account eligibility is read-only, opt-in, and permits exact-profile refresh", () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
      return prior
    }),
    (prior) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
      }),
  ).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const profiles = yield* ProviderAccountProfiles.Service
        expect(yield* eligible(profiles)).toBe(false)
        const account = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Expired but refreshable",
          remoteID: "availability-remote",
          credential: { access: "expired", refresh: "refreshable", expires: 0, accountID: "availability-remote" },
        })
        yield* profiles.clearDefault("openai", "chatgpt-oauth")
        expect(yield* eligible(profiles)).toBe(true)
        expect(yield* profiles.getDefault("openai", "chatgpt-oauth")).toBeUndefined()
        expect((yield* profiles.credential(account.id))?.revision).toBe(0)
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "0"
        expect(yield* eligible(profiles)).toBe(false)
        process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
        yield* profiles.remove(account.id)
        const broken = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Missing identity",
          credential: { access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
        })
        expect(yield* eligible(profiles)).toBe(false)
        yield* profiles.remove(broken.id)
        const empty = yield* profiles.create({
          provider: "openai",
          authMode: "chatgpt-oauth",
          label: "Unrefreshable",
          credential: { access: "expired", refresh: "", expires: 0, accountID: "remote" },
        })
        expect(yield* eligible(profiles)).toBe(false)
        yield* profiles.remove(empty.id)
      }),
    ),
  ),
)
