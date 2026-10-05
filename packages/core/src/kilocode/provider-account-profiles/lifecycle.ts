// kilocode_change - opt-in import of the already reconciled core legacy credential
import { Effect } from "effect"
import { Credential } from "../../credential"
import { Integration } from "@opencode-ai/schema/integration"
import type { Interface } from "../provider-account-profiles"
import { enabled } from "./coordination"

export function importStoredLegacy(
  profiles: Pick<Interface, "importLegacy">,
  credentials: Pick<Credential.Interface, "list">,
) {
  return Effect.gen(function* () {
    if (!enabled() || process.env.KILO_AUTH_CONTENT !== undefined) return { imported: false }
    const legacy = (yield* credentials.list(Integration.ID.make("openai")).pipe(Effect.orDie)).find(
      (item) => item.value.type === "oauth" && item.value.methodID === Integration.MethodID.make("chatgpt-browser"),
    )
    if (!legacy || legacy.value.type !== "oauth") return yield* profiles.importLegacy({})
    return yield* profiles.importLegacy({
      credential: {
        access: legacy.value.access,
        refresh: legacy.value.refresh,
        expires: legacy.value.expires,
        ...(typeof legacy.value.metadata?.accountID === "string" ? { accountID: legacy.value.metadata.accountID } : {}),
      },
      remoteID: typeof legacy.value.metadata?.accountID === "string" ? legacy.value.metadata.accountID : undefined,
    })
  })
}
