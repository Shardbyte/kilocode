import { expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { OpenAIPlugin } from "@opencode-ai/core/plugin/provider/openai"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

it.live("UPA-0 real headless OAuth completion persists into Credential", () =>
  Effect.gen(function* () {
    const original = globalThis.fetch
    const prior = { flag: process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES, auth: process.env.KILO_AUTH_CONTENT }
    process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
    delete process.env.KILO_AUTH_CONTENT
    const calls: string[] = []
    const jwt = `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: "fixture-headless" })).toString("base64url")}.sig`
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        calls.push(url)
        if (url.endsWith("/deviceauth/usercode"))
          return Response.json({ device_auth_id: "fixture-device", user_code: "fixture-code", interval: "1" })
        if (url.endsWith("/deviceauth/token"))
          return Response.json({ authorization_code: "fixture-code", code_verifier: "fixture-verifier" })
        if (url === "https://auth.openai.com/oauth/token")
          return Response.json({
            id_token: jwt,
            access_token: "fixture-headless-access",
            refresh_token: "fixture-headless-refresh",
            expires_in: 60,
          })
        throw new Error("Unexpected OAuth fixture request")
      },
      { preconnect: original.preconnect },
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.fetch = original
        if (prior.flag == null) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
        else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior.flag
        if (prior.auth == null) delete process.env.KILO_AUTH_CONTENT
        else process.env.KILO_AUTH_CONTENT = prior.auth
      }),
    )
    const plugin = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugin)
    const integrations = yield* Integration.Service
    yield* OpenAIPlugin.effect(host).pipe(Effect.provideService(Integration.Service, integrations))
    const attempt = yield* integrations.connection.oauth({
      integrationID: Integration.ID.make("openai"),
      methodID: Integration.MethodID.make("chatgpt-headless"),
      inputs: {},
    })
    const status = yield* integrations.attempt.status(attempt.attemptID).pipe(
      Effect.tap(() => Effect.yieldNow),
      Effect.repeat({ while: (state) => state.status === "pending" }),
      Effect.timeout("5 seconds"),
    )
    expect(status.status).toBe("complete")
    const credentials = yield* Credential.Service
    const stored = yield* credentials.list(Integration.ID.make("openai"))
    expect(stored.at(-1)?.value).toMatchObject({
      type: "oauth",
      methodID: "chatgpt-headless",
      metadata: { accountID: "fixture-headless" },
    })
    expect(calls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ])
  }),
)
