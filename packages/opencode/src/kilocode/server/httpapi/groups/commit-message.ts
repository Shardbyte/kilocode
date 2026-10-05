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
import { CommitMessagePayload } from "@/kilocode/utility-generation-schema"
export { CommitMessagePayload } from "@/kilocode/utility-generation-schema"

const root = "/commit-message"

const PrepareResponse = Schema.Struct({
  model: Schema.Struct({ providerID: ProviderV2.ID, modelID: ModelV2.ID }),
  profilesEnabled: Schema.Boolean,
  requiresAccountContext: Schema.Boolean,
  allowedContextKinds: Schema.Array(Schema.Literals(["legacy", "account"])),
})

const CommitMessageResponse = Schema.Struct({
  message: Schema.String,
})

export class CommitMessageNoChangesError extends Schema.ErrorClass<CommitMessageNoChangesError>(
  "CommitMessageNoChangesError",
)({ message: Schema.String }, { httpApiStatus: 422 }) {}

export class CommitMessageFailedError extends Schema.ErrorClass<CommitMessageFailedError>("CommitMessageFailedError")(
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export const CommitMessageApi = HttpApi.make("commit-message")
  .add(
    HttpApiGroup.make("commit-message")
      .add(
        HttpApiEndpoint.post("prepare", `${root}/prepare`, {
          query: WorkspaceRoutingQuery,
          success: described(PrepareResponse, "Resolved model and available account-context choices"),
          error: [HttpApiError.BadRequest, CommitMessageFailedError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "commitMessage.prepare", summary: "Prepare commit message generation" }),
        ),
      )
      .add(
        HttpApiEndpoint.post("generate", root, {
          query: WorkspaceRoutingQuery,
          payload: CommitMessagePayload,
          success: described(CommitMessageResponse, "Generated commit message"),
          error: [HttpApiError.BadRequest, CommitMessageNoChangesError, CommitMessageFailedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "commitMessage.generate",
            summary: "Generate commit message",
            description: "Generate a commit message using AI based on the current git diff.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "commit-message",
          description: "Kilo commit message routes.",
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
