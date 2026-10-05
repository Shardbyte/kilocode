import { expect, test } from "bun:test"
import { createKiloClient, type ProviderAccountUsage } from "../../src/v2/client"

test("account usage client preserves explicit account identity for reads and refreshes", async () => {
  const requests: Request[] = []
  const value = {
    accountID: "account-A",
    providerID: "openai",
    authMode: "chatgpt-oauth",
    retrievedAt: "2026-10-05T00:00:00.000Z",
    generation: 1,
    snapshot: {
      id: "codex-profile:account-A",
      providerID: "openai",
      sourceKind: "direct",
      providerLabel: "OpenAI",
      planLabel: "ChatGPT Plus",
      sourceLabel: "ChatGPT OAuth",
      fetchState: "ready",
      planState: "active",
      routingState: "not_applicable",
      windows: [],
    },
  } satisfies ProviderAccountUsage
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json(value)
      },
      { preconnect: fetch.preconnect },
    ),
  })

  const first = await client.providerAccounts.usage.get({ accountID: "account-A" })
  expect(first.data).toEqual(value)
  await client.providerAccounts.usage.refresh({ accountID: "account-B" })
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/provider-accounts/account-A/usage"],
    ["POST", "/provider-accounts/account-B/usage/refresh"],
  ])
})
