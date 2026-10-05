import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EnhancePromptPayload } from "@/kilocode/utility-generation-schema"
export { EnhancePromptPayload } from "@/kilocode/utility-generation-schema"

const root = "/enhance-prompt"

const PrepareResponse = Schema.Struct({
  model: Schema.Struct({ providerID: ProviderV2.ID, modelID: ModelV2.ID }),
  profilesEnabled: Schema.Boolean,
  requiresAccountContext: Schema.Boolean,
  allowedContextKinds: Schema.Array(Schema.Literals(["legacy", "account", "session"])),
})

const EnhancePromptResponse = Schema.Struct({
  text: Schema.String,
})

export class EnhancePromptFailedError extends Schema.ErrorClass<EnhancePromptFailedError>("EnhancePromptFailedError")(
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export const EnhancePromptApi = HttpApi.make("enhance-prompt")
  .add(
    HttpApiGroup.make("enhance-prompt")
      .add(
        HttpApiEndpoint.post("prepare", `${root}/prepare`, {
          query: WorkspaceRoutingQuery,
          success: described(PrepareResponse, "Resolved model and available account-context choices"),
          error: [HttpApiError.BadRequest, EnhancePromptFailedError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "enhancePrompt.prepare", summary: "Prepare prompt enhancement" }),
        ),
      )
      .add(
        HttpApiEndpoint.post("enhance", root, {
          query: WorkspaceRoutingQuery,
          payload: EnhancePromptPayload,
          success: described(EnhancePromptResponse, "Enhanced prompt text"),
          error: [HttpApiError.BadRequest, EnhancePromptFailedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "enhancePrompt.enhance",
            summary: "Enhance prompt",
            description: "Rewrite a user's draft prompt into a clearer, more specific, and more effective prompt.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "enhance-prompt",
          description: "Kilo enhance prompt routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
