import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { CommitMessagePayload, EnhancePromptPayload } from "@/kilocode/utility-generation-schema"

describe("utility generation request schemas", () => {
  test("rejects credential fields and enhancement-only contexts for commit generation", () => {
    const decode = Schema.decodeUnknownExit(CommitMessagePayload)
    const model = { providerID: "openai", modelID: "gpt-4.1" }

    expect(
      decode({
        path: "/repo",
        model,
        accountContext: {
          kind: "account",
          providerID: "openai",
          authMode: "chatgpt-oauth",
          accountID: "acct",
          accessToken: "secret",
        },
      })._tag,
    ).toBe("Failure")
    expect(decode({ path: "/repo", model, accountContext: { kind: "session", sourceSessionID: "ses_1" } })._tag).toBe(
      "Failure",
    )
    expect(decode({ path: "/repo", model, accessToken: "secret" })._tag).toBe("Failure")
    expect(decode({ path: "/repo", model: { ...model, apiKey: "secret" } })._tag).toBe("Failure")
  })

  test("allows only the declared enhancement context fields", () => {
    const decode = Schema.decodeUnknownExit(EnhancePromptPayload)

    expect(
      Exit.isSuccess(decode({ text: "draft", accountContext: { kind: "session", sourceSessionID: "ses_1" } })),
    ).toBe(true)
    expect(
      decode({
        text: "draft",
        accountContext: { kind: "legacy", providerID: "openai", apiKey: "secret" },
      })._tag,
    ).toBe("Failure")
  })
})
