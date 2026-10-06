import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { KiloSessionProcessor } from "@/kilocode/session/processor"
import { MessageV2 } from "@/session/message-v2"
import { SessionNetwork } from "@/session/network"
import { SessionID } from "@/session/schema"
import { QuestionID } from "@/question/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetry } from "@/session/retry"
import { Client } from "../../../kilo-telemetry/src/client"
import { TelemetryEvent } from "@kilocode/kilo-telemetry"

test("profile errors retain retry classification but drop provider payloads", () => {
  const transient = new MessageV2.APIError({
    message: "upstream SECRET_TRANSIENT_MESSAGE",
    statusCode: 503,
    isRetryable: true,
    responseBody: "SECRET_TRANSIENT_BODY",
    responseHeaders: {
      authorization: "SECRET_HEADER",
      "retry-after-ms": "1250.5",
      "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
      "set-cookie": "SECRET_COOKIE",
    },
  }).toObject()
  const safe = KiloSessionProcessor.profileError(transient)
  expect(safe).toMatchObject({
    name: "APIError",
    data: {
      message: "The selected provider account request failed.",
      statusCode: 503,
      isRetryable: true,
      responseHeaders: {
        "retry-after-ms": "1250.5",
        "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
      },
    },
  })
  expect(JSON.stringify(safe)).not.toContain("SECRET_")
  expect(SessionV1.APIError.isInstance(safe)).toBe(true)
  if (!SessionV1.APIError.isInstance(safe)) throw new Error("Expected a safe API error")
  expect(SessionRetry.delay(1, safe)).toBe(1250.5)

  const limited = KiloSessionProcessor.profileError(
    new MessageV2.APIError({
      message: "SECRET_RETRY_MESSAGE",
      statusCode: 400,
      isRetryable: false,
      responseBody: "rate limit SECRET_RETRY_BODY",
      responseHeaders: { "retry-after": "1 SECRET_RETRY_HEADER", "retry-after-ms": "2 SECRET_RETRY_HEADER" },
    }).toObject(),
  )
  expect(limited).toMatchObject({ data: { statusCode: 400, isRetryable: true } })
  expect(SessionRetry.retryable(limited)).toEqual({ message: "The selected provider account request failed." })
  expect(JSON.stringify(limited)).not.toContain("SECRET_")
  if (!MessageV2.APIError.isInstance(limited)) throw new Error("Expected a safe API error")
  expect(limited.data.responseHeaders).toBeUndefined()

  for (const status of [429, 503]) {
    const quota = new MessageV2.APIError({
      message: "SECRET_QUOTA_MESSAGE",
      statusCode: status,
      isRetryable: true,
      responseBody: '{"error":"FreeUsageLimitError SECRET_QUOTA_BODY"}',
    }).toObject()
    const capped = KiloSessionProcessor.profileError(quota)
    expect(capped).toMatchObject({ data: { statusCode: status, isRetryable: false } })
    expect(SessionRetry.retryable(KiloSessionProcessor.profileError(quota, true))).toBeUndefined()
    expect(JSON.stringify(capped)).not.toContain("SECRET_")
  }

  const overflow = new MessageV2.ContextOverflowError({
    message: "SECRET_OVERFLOW_MESSAGE",
    responseBody: "SECRET_OVERFLOW_BODY",
  }).toObject()
  const overflowed = KiloSessionProcessor.profileError(overflow)
  expect(MessageV2.ContextOverflowError.isInstance(overflowed)).toBe(true)
  expect(JSON.stringify(overflowed)).not.toContain("SECRET_")
})

test("profile offline helper preserves internal detection and emits only static reconnect text", async () => {
  const raw = new Error("Unable to connect. Is the computer able to access the url? SECRET_HOST SECRET_ACCESS_URL")
  expect(SessionNetwork.disconnected(raw)).toBe(true)
  expect(SessionNetwork.message(raw)).toContain("SECRET_ACCESS_URL")
  const sent: string[] = []
  const states: unknown[] = []
  const ask = spyOn(SessionNetwork, "ask").mockImplementation(async (input) => {
    sent.push(input.message)
    return {
      id: QuestionID.ascending(),
      promise: Promise.reject(new SessionNetwork.RejectedError()),
    }
  })
  const opts = KiloSessionProcessor.retryOpts({
    sessionID: SessionID.make("ses_profile_offline"),
    abort: new AbortController().signal,
    set: (_sessionID, status) => Effect.sync(() => states.push(status)).pipe(Effect.asVoid),
    profileBound: true,
  })
  try {
    const result = await Effect.runPromise(opts.offline({ error: raw, message: SessionNetwork.message(raw) }))
    expect(result).toBe("blocked")
    expect(ask).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([KiloSessionProcessor.PROFILE_OFFLINE_MESSAGE])
    expect(sent.join(" ")).not.toContain("SECRET_")
    expect(states).toMatchObject([{ type: "offline", message: KiloSessionProcessor.PROFILE_OFFLINE_MESSAGE }])
    expect(JSON.stringify(states)).not.toContain("SECRET_")
  } finally {
    ask.mockRestore()
  }
})

test("completion telemetry seam emits only allowlisted completion metrics", () => {
  const calls: Array<{ event: string; props: Record<string, unknown> | undefined }> = []
  const capture = spyOn(Client, "capture").mockImplementation((event, props) => {
    calls.push({ event, props })
  })
  try {
    KiloSessionProcessor.trackStep({
      sessionID: "ses_telemetry_probe",
      model: { providerID: "openai", id: "gpt-5-mini" },
      tokens: { input: 3, output: 2, cache: { read: 1, write: 0 } },
      cost: 0.01,
      elapsed: 42,
    })
    expect(calls).toHaveLength(1)
    expect(calls.at(0)).toMatchObject({
      event: TelemetryEvent.LLM_COMPLETION,
      props: {
        taskId: "ses_telemetry_probe",
        apiProvider: "openai",
        modelId: "gpt-5-mini",
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        cost: 0.01,
        completionTime: 42,
      },
    })
  } finally {
    capture.mockRestore()
  }
})
