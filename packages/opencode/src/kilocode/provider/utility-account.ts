import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { SessionID } from "@/session/schema"
import type { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"

export namespace UtilityAccount {
  const messages = {
    "selection-required": "Select an account or explicitly choose legacy provider authentication for this generation",
    "account-unavailable": "The selected OpenAI account is unavailable",
    "context-mismatch": "The account context does not match this utility operation or provider",
    "profiles-disabled": "OpenAI account profiles are disabled; a profile context cannot be used",
    "source-unavailable": "The source session is unavailable in this project",
    "source-unbound": "The source session requires an OpenAI account binding",
    "model-unavailable": "The selected utility model is unavailable; prepare this generation again",
  } as const

  export class Failure extends Error {
    constructor(readonly code: keyof typeof messages) {
      super(messages[code])
      this.name = "UtilityAccountError"
    }
  }

  export function message(err: unknown, fallback: string) {
    return err instanceof Failure ? (messages[err.code] ?? fallback) : fallback
  }

  export type Operation =
    | "commit-message"
    | "branch-name"
    | "title"
    | "memory"
    | "enhance-prompt"
    | "agent-generation"
    | "roll-call"

  export type Context =
    | { kind: "session"; sourceSessionID: string }
    | { kind: "account"; providerID: "openai"; authMode: "chatgpt-oauth"; accountID: string }
    | { kind: "legacy"; providerID: string }

  type IdentityBase = {
    readonly id: string
    readonly operation: Operation
    readonly directory: string
    readonly providerID: string
    readonly modelID: string
    readonly sourceSessionID?: string
  }

  export type Identity = Readonly<
    | (IdentityBase & { mode: "profile"; profileID: string })
    | (IdentityBase & { mode: "legacy" })
    | (IdentityBase & { mode: "outside" })
  >

  type Input = {
    operation: Operation
    model: { providerID: string; id: string }
    context?: Context
  }

  const admit = Effect.fn("UtilityAccount.admit")(function* (
    input: Input,
    sessions?: {
      get: (id: SessionID) => Effect.Effect<{ projectID: string; directory: string }, unknown>
      binding: (id: SessionID) => Effect.Effect<SessionBinding.Info | undefined, unknown>
    },
  ) {
    const module = yield* Effect.promise(() => import("@/effect/instance-state"))
    const instance = yield* module.InstanceState.context
    const directory = instance.directory
    const profiles = yield* ProviderAccountProfiles.Service
    const context = input.context
    const source = context?.kind === "session" ? context : undefined
    if (
      (source && !["branch-name", "title", "memory", "enhance-prompt"].includes(input.operation)) ||
      (!source && ["branch-name", "title", "memory"].includes(input.operation))
    )
      return yield* Effect.fail(new Failure("context-mismatch"))

    const persisted = source
      ? yield* Effect.gen(function* () {
          if (!sessions) return yield* Effect.fail(new Failure("context-mismatch"))
          const session = yield* sessions
            .get(SessionID.make(source.sourceSessionID))
            .pipe(Effect.mapError(() => new Failure("source-unavailable")))
          if (session.projectID !== instance.project.id || session.directory !== directory)
            return yield* Effect.fail(new Failure("source-unavailable"))
          return input.model.providerID === "openai"
            ? yield* sessions.binding(SessionID.make(source.sourceSessionID))
            : undefined
        })
      : undefined

    const base = {
      id: randomUUID(),
      operation: input.operation,
      directory,
      providerID: input.model.providerID,
      modelID: input.model.id,
      ...(source && { sourceSessionID: source.sourceSessionID }),
    }
    const identity = (mode: "legacy" | "outside"): Identity => Object.freeze({ ...base, mode })
    const profile = (profileID: string): Identity => Object.freeze({ ...base, mode: "profile", profileID })

    if (context?.kind === "account") {
      if (
        context.providerID !== "openai" ||
        context.authMode !== "chatgpt-oauth" ||
        input.model.providerID !== context.providerID
      )
        return yield* Effect.fail(new Failure("context-mismatch"))
      if (!ProviderAccountProfiles.enabled()) return yield* Effect.fail(new Failure("profiles-disabled"))
      const info = yield* profiles.get(context.accountID)
      const credential = yield* profiles.credential(context.accountID)
      if (!info || info.provider !== "openai" || info.authMode !== context.authMode || !credential)
        return yield* Effect.fail(new Failure("account-unavailable"))
      return profile(context.accountID)
    }

    if (context?.kind === "legacy") {
      if (input.model.providerID !== context.providerID) return yield* Effect.fail(new Failure("context-mismatch"))
      return identity(input.model.providerID === "openai" ? "legacy" : "outside")
    }

    if (source && input.model.providerID === "openai") {
      const binding = persisted?.providers.openai
      if (!binding || binding.mode === "unbound") return yield* Effect.fail(new Failure("source-unbound"))
      if (binding.mode === "legacy") return identity("legacy")
      if (!ProviderAccountProfiles.enabled()) return yield* Effect.fail(new Failure("profiles-disabled"))
      const info = yield* profiles.get(binding.profileID)
      const credential = yield* profiles.credential(binding.profileID)
      if (
        binding.authMode !== "chatgpt-oauth" ||
        !info ||
        info.provider !== "openai" ||
        info.authMode !== "chatgpt-oauth" ||
        !credential
      )
        return yield* Effect.fail(new Failure("account-unavailable"))
      return profile(binding.profileID)
    }

    if (input.model.providerID === "openai" && ProviderAccountProfiles.enabled())
      return yield* Effect.fail(new Failure("selection-required"))
    return identity(input.model.providerID === "openai" ? "legacy" : "outside")
  })

  export const resolve = Effect.fn("UtilityAccount.resolve")(function* (input: Input) {
    const module = yield* Effect.promise(() => import("@/session/session"))
    const sessions = yield* module.Session.Service
    return yield* admit(input, sessions)
  })

  export const standalone: (input: {
    operation: "commit-message" | "enhance-prompt" | "agent-generation" | "roll-call"
    model: Input["model"]
    context?: Exclude<Context, { kind: "session" }>
  }) => Effect.Effect<Identity, unknown, ProviderAccountProfiles.Service> = Effect.fn("UtilityAccount.standalone")(
    (input) => admit(input),
  )
}
