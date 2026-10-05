import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { EffectBridge } from "@/effect/bridge"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Config } from "@/config/config"
import { generateCommitMessage, NoChangesError, prepareCommitMessage } from "@/kilocode/commit-message"
import { CommitMessageFailedError, CommitMessageNoChangesError } from "../groups/commit-message"
import { CommitMessagePayload } from "@/kilocode/utility-generation-schema"
import { UtilityAccount } from "@/kilocode/provider/utility-account"

export const commitMessageHandlers = HttpApiBuilder.group(InstanceHttpApi, "commit-message", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    const prepare = Effect.fn("CommitMessageHttpApi.prepare")(() =>
      EffectBridge.fromPromise(() => prepareCommitMessage()).pipe(
        Effect.catchDefect((err) =>
          Effect.fail(
            new CommitMessageFailedError({
              message: UtilityAccount.message(err, "Failed to prepare commit message generation"),
            }),
          ),
        ),
      ),
    )

    const generate = Effect.fn("CommitMessageHttpApi.generate")(function* (ctx: {
      payload: typeof CommitMessagePayload.Type
    }) {
      const cfg = yield* config.get()
      const prompt = cfg.commit_message?.prompt || undefined
      const result = yield* EffectBridge.fromPromise(() =>
        generateCommitMessage({
          path: ctx.payload.path,
          selectedFiles: ctx.payload.selectedFiles ? [...ctx.payload.selectedFiles] : undefined,
          previousMessage: ctx.payload.previousMessage,
          prompt,
          language: ctx.payload.language,
          model: ctx.payload.model,
          accountContext: ctx.payload.accountContext,
        }),
      ).pipe(
        Effect.catchDefect((defect) => {
          if (defect instanceof NoChangesError) {
            return Effect.fail(new CommitMessageNoChangesError({ message: defect.message }))
          }
          if (defect instanceof Error) {
            const message = UtilityAccount.message(defect, "Failed to generate commit message")
            return Effect.fail(new CommitMessageFailedError({ message }))
          }
          return Effect.fail(new CommitMessageFailedError({ message: "Failed to generate commit message" }))
        }),
      )
      return { message: result.message }
    })

    return handlers.handle("prepare", prepare).handle("generate", generate)
  }),
)
