import { Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const Model = Schema.Struct({ providerID: ProviderV2.ID, modelID: ModelV2.ID })
const AccountContext = [
  Schema.Struct({
    kind: Schema.Literal("account"),
    providerID: Schema.Literal("openai"),
    authMode: Schema.Literal("chatgpt-oauth"),
    accountID: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("legacy"), providerID: Schema.String }),
] as const

export const CommitMessagePayload = Schema.Struct({
  path: Schema.String.annotate({ description: "Workspace/repo path" }),
  selectedFiles: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional subset of files to include",
  }),
  previousMessage: Schema.optional(Schema.String).annotate({
    description: "Previously generated message — triggers regeneration with a different result",
  }),
  language: Schema.optional(Schema.String).annotate({
    description: "Target language for the generated commit message (e.g. zh, en). Falls back to English.",
  }),
  model: Schema.optional(Model),
  accountContext: Schema.optional(Schema.Union(AccountContext)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const EnhancePromptPayload = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "The user's draft prompt to enhance" }),
  model: Schema.optional(Model),
  accountContext: Schema.optional(
    Schema.Union([
      ...AccountContext,
      Schema.Struct({ kind: Schema.Literal("session"), sourceSessionID: Schema.String }),
    ] as const),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
