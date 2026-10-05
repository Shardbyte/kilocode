import { afterEach, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import * as Log from "@opencode-ai/core/util/log"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { PublicApi } from "../../../src/server/routes/instance/httpapi/public"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

test("provider account OpenAPI preserves nullability and finite nonnegative integers", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const info = spec.components?.schemas?.ProviderAccountInfo as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  const list = spec.components?.schemas?.ProviderAccountList as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  const auth = spec.components?.schemas?.ProviderAccountAuthState as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  const usage = spec.components?.schemas?.ProviderAccountUsage as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  const reauth = spec.paths?.["/provider-accounts/{accountID}/oauth/start"]?.post as
    | { requestBody?: { content?: { "application/json"?: { schema?: { properties?: Record<string, unknown> } } } } }
    | undefined
  const integer = (value: unknown) => {
    const text = JSON.stringify(value)
    expect(text).toContain('"type":"integer"')
    expect(text).toContain('"minimum":0')
    expect(text).not.toMatch(/NaN|Infinity/)
  }

  expect(info?.properties?.remoteID).toEqual({ type: "string" })
  expect(list?.properties?.defaultAccountID).toEqual({ type: "string" })
  expect(info?.required).not.toContain("remoteID")
  expect(info?.required).not.toContain("revision")
  expect(list?.required).not.toContain("defaultAccountID")
  expect(auth?.required).not.toContain("revision")
  expect(info?.properties?.revision).toMatchObject({ type: "integer" })
  expect(auth?.properties?.revision).toMatchObject({ type: "integer" })
  integer(info?.properties?.revision)
  integer(info?.properties?.timeCreated)
  integer(info?.properties?.timeUpdated)
  integer(auth?.properties?.revision)
  integer(reauth?.requestBody?.content?.["application/json"]?.schema?.properties?.expectedRevision)
  expect(usage?.required).toEqual(
    expect.arrayContaining(["accountID", "providerID", "authMode", "retrievedAt", "generation", "snapshot"]),
  )
  expect(usage?.properties?.accountID).toEqual({ type: "string" })
  expect(usage?.properties?.authMode).toEqual({ type: "string", enum: ["chatgpt-oauth"] })
  integer(usage?.properties?.generation)
  expect(spec.paths?.["/provider-accounts/{accountID}/usage"]?.get).toBeDefined()
  expect(spec.paths?.["/provider-accounts/{accountID}/usage/refresh"]?.post).toBeDefined()
  expect(JSON.stringify(usage?.properties?.snapshot)).toContain("UsageSnapshot")
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("provider account lifecycle API is opt-in and serializes only safe errors", async () => {
  const prior = process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
  try {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const handler = HttpRouter.toWebHandler(
      HttpApiServer.routes.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "true",
            }),
          ),
        ),
      ),
      { disableLogger: true },
    ).handler

    const response = await handler(
      new Request("http://localhost/provider-accounts?provider=openai", {
        headers: { "x-kilo-directory": tmp.path },
      }),
      HttpApiServer.context,
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { _tag?: string; error?: string; message?: string }
    expect(body.error).toBe("Disabled")
    expect(body.message).toBe("Provider profiles are disabled")
    expect(JSON.stringify(body)).not.toContain("access")
    expect(JSON.stringify(body)).not.toContain("refresh")
  } finally {
    if (prior === undefined) delete process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES
    else process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = prior
  }
})
