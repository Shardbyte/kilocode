import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { EffectBridge } from "@/effect/bridge"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { enhancePrompt, prepareEnhancePrompt } from "@/kilocode/enhance-prompt"
import { EnhancePromptFailedError } from "../groups/enhance-prompt"
import { EnhancePromptPayload } from "@/kilocode/utility-generation-schema"
import { UtilityAccount } from "@/kilocode/provider/utility-account"

export const enhancePromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "enhance-prompt", (handlers) =>
  Effect.gen(function* () {
    const enhance = Effect.fn("EnhancePromptHttpApi.enhance")(function* (ctx: {
      payload: typeof EnhancePromptPayload.Type
    }) {
      const text = yield* EffectBridge.fromPromise(() =>
        enhancePrompt(ctx.payload.text, {
          model: ctx.payload.model,
          accountContext: ctx.payload.accountContext,
        }),
      ).pipe(
        Effect.catchDefect((defect) => {
          const message = UtilityAccount.message(defect, "Failed to enhance prompt")
          return Effect.fail(new EnhancePromptFailedError({ message }))
        }),
      )
      return { text }
    })

    const prepare = Effect.fn("EnhancePromptHttpApi.prepare")(() =>
      EffectBridge.fromPromise(() => prepareEnhancePrompt()).pipe(
        Effect.catchDefect((err) =>
          Effect.fail(
            new EnhancePromptFailedError({
              message: UtilityAccount.message(err, "Failed to prepare prompt enhancement"),
            }),
          ),
        ),
      ),
    )

    return handlers.handle("prepare", prepare).handle("enhance", enhance)
  }),
)
