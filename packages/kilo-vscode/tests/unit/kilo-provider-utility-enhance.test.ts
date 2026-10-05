import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import * as vscode from "vscode"

const { KiloProvider } = await import("../../src/KiloProvider")
const original = {
  pick: vscode.window.showQuickPick,
  change: vscode.window.onDidChangeWindowState,
  state: vscode.window.state,
}
const pick = mock(async (_items: unknown[]) => undefined as unknown)
const change = (listener: (state: { focused: boolean }) => void) => ({ dispose() {} })

type Internals = {
  currentSession: { id: string } | null
  handleUtilityEnhance(msg: Record<string, unknown>): Promise<void>
}

function setup(
  plan = {
    model: { providerID: "openai", modelID: "gpt-4.1-mini" },
    profilesEnabled: true,
    requiresAccountContext: true,
    allowedContextKinds: ["account", "legacy", "session"],
  },
) {
  const client = {
    enhancePrompt: {
      prepare: mock(async () => ({ data: plan })),
      enhance: mock(async () => ({ data: { text: "Improved prompt" } })),
    },
    providerAccounts: {
      list: mock(async () => ({
        data: { accounts: [{ id: "profile-id", label: "Personal", isDefault: true, authState: "ready" }] },
      })),
    },
  }
  const connection = { getClient: () => client, sandboxPreference: undefined }
  const provider = new KiloProvider({} as never, connection as never, undefined, {
    rootDirectory: () => "/repo",
  })
  const internal = provider as unknown as Internals
  internal.currentSession = null
  const messages: Array<Record<string, unknown>> = []
  provider.postMessage = (msg) => void messages.push(msg as Record<string, unknown>)
  return { client, internal, messages }
}

beforeEach(() =>
  Object.assign(vscode.window, { showQuickPick: pick, onDidChangeWindowState: change, state: { focused: true } }),
)
afterEach(() => {
  Object.assign(vscode.window, {
    showQuickPick: original.pick,
    onDidChangeWindowState: original.change,
    state: original.state,
  })
  pick.mockClear()
})

describe("KiloProvider prompt enhancement authority", () => {
  it("uses explicit standalone selection for NewWorktree instead of borrowing the visible session", async () => {
    const { client, internal } = setup()
    internal.currentSession = { id: "visible-chat-session" }
    pick.mockImplementation(async (items) => items[0])

    await internal.handleUtilityEnhance({
      source: "new-worktree",
      sessionID: "visible-chat-session",
      requestId: "request",
      text: "Draft",
    })

    expect(pick).toHaveBeenCalledTimes(1)
    expect(client.providerAccounts.list).toHaveBeenCalledWith(
      { provider: "openai", directory: "/repo" },
      { throwOnError: true },
    )
    expect(client.enhancePrompt.enhance.mock.calls[0]?.[0]).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-4.1-mini" },
      accountContext: { kind: "account", accountID: "profile-id" },
    })
    expect(client.enhancePrompt.enhance.mock.calls[0]?.[0]).not.toHaveProperty("accountContext.sourceSessionID")
  })

  it("sends session context only for a matching active chat session", async () => {
    const { client, internal } = setup()
    internal.currentSession = { id: "chat-session" }
    await internal.handleUtilityEnhance({
      source: "chat",
      sessionID: "chat-session",
      requestId: "request",
      text: "Draft",
    })

    expect(client.providerAccounts.list).not.toHaveBeenCalled()
    expect(client.enhancePrompt.enhance.mock.calls[0]?.[0]).toMatchObject({
      accountContext: { kind: "session", sourceSessionID: "chat-session" },
    })
  })

  it("rejects stale session provenance before backend preparation", async () => {
    const { client, internal, messages } = setup()
    internal.currentSession = { id: "new-session" }
    await internal.handleUtilityEnhance({
      source: "chat",
      sessionID: "old-session",
      requestId: "request",
      text: "Draft",
    })

    expect(client.enhancePrompt.prepare).not.toHaveBeenCalled()
    expect(client.enhancePrompt.enhance).not.toHaveBeenCalled()
    expect(messages.at(-1)).toMatchObject({ type: "enhancePromptError", requestId: "request" })
  })

  it("does not issue generation after the picker is cancelled", async () => {
    const { client, internal, messages } = setup()
    pick.mockResolvedValue(undefined)
    await internal.handleUtilityEnhance({ source: "new-worktree", requestId: "request", text: "Draft" })

    expect(client.enhancePrompt.prepare).toHaveBeenCalledTimes(1)
    expect(client.enhancePrompt.enhance).not.toHaveBeenCalled()
    expect(messages.at(-1)).toMatchObject({ type: "enhancePromptError", requestId: "request" })
  })
})
