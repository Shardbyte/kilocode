import { expect, test } from "bun:test"
import { createKiloClient } from "../../src/v2/client"

test("utility SDK preserves frozen models and operation-specific credential-free contexts", async () => {
  const requests: Array<{ path: string; directory: string | null; body: unknown }> = []
  const model = { providerID: "openai", modelID: "gpt-5-mini" }
  const prepared = {
    model,
    profilesEnabled: true,
    requiresAccountContext: true,
    allowedContextKinds: ["account", "legacy"],
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)
        const text = await request.text()
        requests.push({
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          body: text ? JSON.parse(text) : null,
        })
        if (url.pathname.endsWith("/prepare")) return Response.json(prepared)
        if (url.pathname === "/commit-message") return Response.json({ message: "Fix utility authority" })
        return Response.json({ text: "Improve utility authority" })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const directory = "/backend-local/repository"
  expect((await client.commitMessage.prepare({ directory }, { throwOnError: true })).data).toEqual(prepared)
  await client.commitMessage.generate({
    directory,
    path: directory,
    model,
    accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "account-A" },
  })
  await client.commitMessage.generate({
    directory,
    path: directory,
    model,
    accountContext: { kind: "legacy", providerID: "openai" },
  })
  await client.enhancePrompt.prepare({ directory })
  await client.enhancePrompt.enhance({
    directory,
    text: "Improve this",
    model,
    accountContext: { kind: "session", sourceSessionID: "ses_source" },
  })
  expect(requests).toEqual([
    { path: "/commit-message/prepare", directory, body: null },
    {
      path: "/commit-message",
      directory,
      body: {
        path: directory,
        model,
        accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "account-A" },
      },
    },
    {
      path: "/commit-message",
      directory,
      body: { path: directory, model, accountContext: { kind: "legacy", providerID: "openai" } },
    },
    { path: "/enhance-prompt/prepare", directory, body: null },
    {
      path: "/enhance-prompt",
      directory,
      body: { text: "Improve this", model, accountContext: { kind: "session", sourceSessionID: "ses_source" } },
    },
  ])
  expect(JSON.stringify(requests)).not.toMatch(/access[_-]?token|refresh[_-]?token|authorization|credential|revision/i)
})
