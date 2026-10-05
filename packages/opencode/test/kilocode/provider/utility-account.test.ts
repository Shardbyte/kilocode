import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionDrain } from "@/kilocode/session/drain"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Session } from "@/session/session"
import { UtilityAccount } from "@/kilocode/provider/utility-account"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      BackgroundJob.node,
      EventV2Bridge.node,
      EventV2.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      ProviderAccountProfiles.node,
      SessionBinding.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionDrain.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  ),
)
const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
const model = { providerID: "openai", id: "gpt-5-mini" }
const standalone = testEffect(LayerNode.compile(ProviderAccountProfiles.node))

const create = Effect.fn("UtilityAccountTest.create")(function* () {
  const profiles = yield* ProviderAccountProfiles.Service
  return yield* profiles.create({
    provider: "openai",
    authMode: "chatgpt-oauth",
    label: "Explicit account",
    credential: {
      access: "AUTHORITY_ACCESS_MARKER",
      refresh: "AUTHORITY_REFRESH_MARKER",
      expires: Date.now() + 60_000,
    },
  })
})

const denied = Effect.fn("UtilityAccountTest.denied")(function* (
  input: Parameters<typeof UtilityAccount.resolve>[0],
  code: UtilityAccount.Failure["code"],
) {
  const result = yield* UtilityAccount.resolve(input).pipe(Effect.catch((err) => Effect.succeed(err)))
  expect(result).toBeInstanceOf(UtilityAccount.Failure)
  if (result instanceof UtilityAccount.Failure) expect(result.code).toBe(code)
})

beforeEach(() => {
  process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
})

afterEach(() => {
  if (prior == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
})

describe("utility account resolution", () => {
  standalone.instance("admits a standalone account without creating or depending on a session", () =>
    Effect.gen(function* () {
      const account = yield* create()
      expect(
        yield* UtilityAccount.standalone({
          operation: "agent-generation",
          model,
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: account.id },
        }),
      ).toMatchObject({ mode: "profile", profileID: account.id })
    }),
  )
  it.instance("resolves source-session binding instead of synthetic request identity", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const account = yield* profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "resolver-test",
        credential: {
          access: "RESOLVER_TEST_ACCESS",
          refresh: "RESOLVER_TEST_REFRESH",
          expires: Date.now() + 60_000,
        },
      })
      yield* profiles.selectDefault("openai", "chatgpt-oauth", account.id)
      const sessions = yield* Session.Service
      const source = yield* sessions.create()
      const identity = yield* UtilityAccount.resolve({
        operation: "branch-name",
        model,
        context: { kind: "session", sourceSessionID: source.id },
      })

      expect(identity).toMatchObject({
        operation: "branch-name",
        directory: source.directory,
        providerID: model.providerID,
        modelID: model.id,
        mode: "profile",
        profileID: account.id,
        sourceSessionID: source.id,
      })
      expect(Object.isFrozen(identity)).toBe(true)
      expect(JSON.stringify(identity)).not.toContain("RESOLVER_TEST_")
      expect(identity.id).not.toContain(source.id)
    }),
  )

  it.instance("rejects utility session authority for standalone operations and mismatched accounts", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create()
      const denied = yield* Effect.exit(
        UtilityAccount.resolve({
          operation: "agent-generation",
          model,
          context: { kind: "session", sourceSessionID: source.id },
        }),
      )
      expect(denied._tag).toBe("Failure")

      const unbound = yield* Effect.exit(
        UtilityAccount.resolve({
          operation: "branch-name",
          model,
          context: { kind: "session", sourceSessionID: source.id },
        }),
      )
      expect(unbound._tag).toBe("Failure")

      const mismatch = yield* Effect.exit(
        UtilityAccount.resolve({
          operation: "agent-generation",
          model: { providerID: "anthropic", id: "claude" },
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "profile-x" },
        }),
      )
      expect(mismatch._tag).toBe("Failure")
    }),
  )

  it.instance("never treats the only account or new-session default as standalone authority", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const account = yield* create()
      yield* profiles.selectDefault("openai", "chatgpt-oauth", account.id)
      for (const operation of ["commit-message", "enhance-prompt", "agent-generation", "roll-call"] as const)
        yield* denied({ operation, model }, "selection-required")
    }),
  )

  it.instance("distinguishes explicit legacy, disabled compatibility, and outside-provider authority", () =>
    Effect.gen(function* () {
      expect(
        yield* UtilityAccount.resolve({
          operation: "commit-message",
          model,
          context: { kind: "legacy", providerID: "openai" },
        }),
      ).toMatchObject({ mode: "legacy" })
      expect(
        yield* UtilityAccount.resolve({
          operation: "commit-message",
          model: { providerID: "anthropic", id: "claude" },
        }),
      ).toMatchObject({ mode: "outside" })
      delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      expect(yield* UtilityAccount.resolve({ operation: "commit-message", model })).toMatchObject({ mode: "legacy" })
    }),
  )

  it.instance("rejects disabled profile contexts instead of downgrading to legacy", () =>
    Effect.gen(function* () {
      const account = yield* create()
      delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
      yield* denied(
        {
          operation: "commit-message",
          model,
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: account.id },
        },
        "profiles-disabled",
      )
    }),
  )

  it.instance("requires real source authority for branch, title, and memory; account overrides are ineligible", () =>
    Effect.gen(function* () {
      const account = yield* create()
      for (const operation of ["branch-name", "title", "memory"] as const) {
        yield* denied({ operation, model }, "context-mismatch")
        yield* denied({ operation, model, context: { kind: "legacy", providerID: "openai" } }, "context-mismatch")
        yield* denied(
          {
            operation,
            model,
            context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: account.id },
          },
          "context-mismatch",
        )
      }
    }),
  )

  it.instance("keeps non-OpenAI execution independent of an unbound OpenAI source", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create()
      const context = { kind: "session", sourceSessionID: source.id } as const
      yield* denied({ operation: "title", model, context }, "source-unbound")
      expect(
        yield* UtilityAccount.resolve({
          operation: "title",
          model: { providerID: "anthropic", id: "claude" },
          context,
        }),
      ).toMatchObject({ mode: "outside", sourceSessionID: source.id })
    }),
  )

  it.instance("rejects deleted accounts and mismatched explicit legacy providers", () =>
    Effect.gen(function* () {
      const profiles = yield* ProviderAccountProfiles.Service
      const account = yield* create()
      yield* profiles.remove(account.id)
      yield* denied(
        {
          operation: "commit-message",
          model,
          context: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: account.id },
        },
        "account-unavailable",
      )
      yield* denied(
        { operation: "commit-message", model, context: { kind: "legacy", providerID: "anthropic" } },
        "context-mismatch",
      )
    }),
  )
})
