import { ProviderV2 } from "@opencode-ai/core/provider"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const root = "/provider-accounts"

export const AccountInfo = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  authMode: Schema.Literal("chatgpt-oauth"),
  label: Schema.String,
  remoteID: Schema.optional(Schema.String),
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
  isDefault: Schema.Boolean,
  revision: Schema.optional(NonNegativeInt),
  authState: Schema.Literals(["ready", "expired", "missing"]),
}).annotate({ identifier: "ProviderAccountInfo" })

export const AccountList = Schema.Struct({
  accounts: Schema.Array(AccountInfo),
  defaultAccountID: Schema.optional(Schema.String),
}).annotate({ identifier: "ProviderAccountList" })

export const AuthState = Schema.Struct({
  accountID: Schema.String,
  state: Schema.Literals(["ready", "expired", "missing"]),
  revision: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "ProviderAccountAuthState" })

export const Operation = Schema.Struct({
  operationID: Schema.String,
  url: Schema.String,
  instructions: Schema.String,
}).annotate({ identifier: "ProviderAccountOAuthOperation" })

export const OperationResult = Schema.Struct({
  account: AccountInfo,
}).annotate({ identifier: "ProviderAccountOAuthResult" })

export const CreateOAuthInput = Schema.Struct({
  label: Schema.String,
})

export const ReauthOAuthInput = Schema.Struct({
  expectedRevision: NonNegativeInt,
})

export const CompleteInput = Schema.Struct({
  operationID: Schema.String,
})

export const RenameInput = Schema.Struct({
  label: Schema.String,
})

export const DefaultInput = Schema.Struct({
  accountID: Schema.String,
})

export const AssignInput = Schema.Struct({
  accountID: Schema.String,
  confirmRepair: Schema.optional(Schema.Boolean),
})

export const SessionBindingResult = Schema.NullOr(SessionBinding.Entry).annotate({
  identifier: "ProviderAccountSessionBinding",
})

export class ProviderAccountApiError extends Schema.ErrorClass<ProviderAccountApiError>("ProviderAccountApiError")(
  {
    error: Schema.Literals([
      "Disabled",
      "NotFound",
      "Conflict",
      "Duplicate",
      "IdentityMismatch",
      "InvalidRequest",
      "OAuthFailed",
      "StorageFailed",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const apiError = [ProviderAccountApiError, HttpApiError.NotFound]

export const ProviderAccountsApi = HttpApi.make("provider-accounts")
  .add(
    HttpApiGroup.make("provider-accounts")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, provider: ProviderV2.ID }),
          success: described(AccountList, "Provider accounts"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.list",
            summary: "List provider accounts",
            description: "List safe metadata for local OAuth profiles; credentials are never returned.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:accountID`, {
          params: { accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AccountInfo, "Provider account"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.get",
            summary: "Get provider account",
            description: "Get safe metadata and credential health for one local OAuth profile.",
          }),
        ),
        HttpApiEndpoint.get("authState", `${root}/:accountID/auth-state`, {
          params: { accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthState, "Provider account credential health"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.authState",
            summary: "Get provider account credential health",
            description: "Report safe credential health derived from its stored expiration without refreshing it.",
          }),
        ),
        HttpApiEndpoint.post("createOAuth", `${root}/oauth/start`, {
          query: WorkspaceRoutingQuery,
          payload: CreateOAuthInput,
          success: described(Operation, "OAuth operation"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.oauth.start",
            summary: "Start adding a provider account",
            description: "Start an isolated OAuth operation and return its authorization URL and opaque operation ID.",
          }),
        ),
        HttpApiEndpoint.post("reauthOAuth", `${root}/:accountID/oauth/start`, {
          params: { accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ReauthOAuthInput,
          success: described(Operation, "OAuth reauthentication operation"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.oauth.reauthenticate",
            summary: "Start provider account reauthentication",
            description:
              "Start an isolated reauthentication bound to the target profile's expected credential revision.",
          }),
        ),
        HttpApiEndpoint.post("completeOAuth", `${root}/oauth/complete`, {
          query: WorkspaceRoutingQuery,
          payload: CompleteInput,
          success: described(OperationResult, "OAuth operation result"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.oauth.complete",
            summary: "Complete provider OAuth",
            description: "Complete one isolated OAuth operation. Credentials remain server-side and are not returned.",
          }),
        ),
        HttpApiEndpoint.delete("cancelOAuth", `${root}/oauth/:operationID`, {
          params: { operationID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "OAuth operation canceled"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.oauth.cancel",
            summary: "Cancel provider OAuth",
            description: "Cancel one unfinished OAuth operation by its opaque operation ID.",
          }),
        ),
        HttpApiEndpoint.patch("rename", `${root}/:accountID`, {
          params: { accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: RenameInput,
          success: described(AccountInfo, "Renamed provider account"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.rename",
            summary: "Rename provider account",
            description: "Change the local display label of a provider account.",
          }),
        ),
        HttpApiEndpoint.put("default", `${root}/:providerID/default`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: DefaultInput,
          success: described(Schema.Boolean, "Default provider account selected"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.default.select",
            summary: "Select default provider account",
            description: "Select the local default OAuth profile for a provider.",
          }),
        ),
        HttpApiEndpoint.delete("clearDefault", `${root}/:providerID/default`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Default provider account cleared"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.default.clear",
            summary: "Clear default provider account",
            description: "Clear the selected default without selecting another profile.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:accountID`, {
          params: { accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Provider account removed"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.remove",
            summary: "Remove provider account",
            description: "Remove one local provider profile and its credential.",
          }),
        ),
        HttpApiEndpoint.put("assignSession", "/session/:sessionID/provider-accounts/:providerID", {
          params: { sessionID: SessionID, providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: AssignInput,
          success: described(SessionBinding.Info, "Session provider account bindings"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.session.assign",
            summary: "Assign session provider account",
            description: "Assign or explicitly repair an opaque provider profile binding for a session.",
          }),
        ),
        HttpApiEndpoint.get("sessionBinding", "/session/:sessionID/provider-accounts/:providerID", {
          params: { sessionID: SessionID, providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(SessionBindingResult, "Session provider account binding"),
          error: apiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "providerAccounts.session.get",
            summary: "Get session provider account binding",
            description: "Read the safe local provider profile binding for a session.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider-accounts",
          description: "Guarded lifecycle APIs for local provider OAuth profiles.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "provider account HttpApi",
      version: "0.0.1",
      description: "Guarded local provider profile lifecycle API.",
    }),
  )
