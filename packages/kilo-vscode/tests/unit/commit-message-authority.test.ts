import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import * as vscode from "vscode"

const cmds = mock((_id: string, _handler: (arg?: unknown) => unknown) => ({ dispose() {} }))
const pick = mock(async (_items: unknown[]) => undefined as unknown)
const progress = mock(async (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<void>) =>
  task({}, { onCancellationRequested: () => ({ dispose() {} }) }),
)
const git = mock(() => ({ repositories: [] as Array<{ inputBox: { value: string }; rootUri: { fsPath: string } }> }))
const extension = { isActive: true, activate: async () => {}, exports: { getAPI: git } }
const modules = { getExtension: mock(() => extension) }
const shown: string[] = []
const original = {
  registerCommand: vscode.commands.registerCommand,
  getExtension: vscode.extensions.getExtension,
  showErrorMessage: vscode.window.showErrorMessage,
  showQuickPick: vscode.window.showQuickPick,
  withProgress: vscode.window.withProgress,
  workspaceFolders: vscode.workspace.workspaceFolders,
  getConfiguration: vscode.workspace.getConfiguration,
  language: vscode.env.language,
}

function install() {
  Object.assign(vscode.commands, { registerCommand: cmds })
  Object.assign(vscode.extensions, { getExtension: modules.getExtension })
  Object.assign(vscode.window, {
    showErrorMessage: (text: string) => shown.push(text),
    showQuickPick: pick,
    withProgress: progress,
  })
  Object.assign(vscode.workspace, { workspaceFolders: [], getConfiguration: () => ({ get: () => "sync" }) })
  Object.assign(vscode.env, { language: "en" })
}

function restore() {
  Object.assign(vscode.commands, { registerCommand: original.registerCommand })
  Object.assign(vscode.extensions, { getExtension: original.getExtension })
  Object.assign(vscode.window, {
    showErrorMessage: original.showErrorMessage,
    showQuickPick: original.showQuickPick,
    withProgress: original.withProgress,
  })
  Object.assign(vscode.workspace, {
    workspaceFolders: original.workspaceFolders,
    getConfiguration: original.getConfiguration,
  })
  Object.assign(vscode.env, { language: original.language })
}

const { registerCommitMessageService } = await import("../../src/services/commit-message")

describe("SCM commit authority", () => {
  beforeEach(() => {
    install()
    cmds.mockClear()
    pick.mockClear()
    progress.mockClear()
    git.mockClear()
    modules.getExtension.mockClear()
    shown.length = 0
  })

  afterEach(restore)

  function setup(
    plan = {
      model: { providerID: "openai", modelID: "gpt-4.1-mini" },
      profilesEnabled: true,
      requiresAccountContext: true,
      allowedContextKinds: ["account", "legacy"],
    },
  ) {
    const input = { value: "" }
    const repo = { inputBox: input, rootUri: { fsPath: "/repo" } }
    git.mockReturnValue({ repositories: [repo] })
    const client = {
      commitMessage: {
        prepare: mock(async (opts: unknown) => ({ data: plan, opts })),
        generate: mock(async () => ({ data: { message: "feat: generated" } })),
      },
      providerAccounts: {
        list: mock(async () => ({
          data: {
            accounts: [
              {
                id: "account-id",
                label: "Personal",
                isDefault: true,
                authState: "ready",
                accessToken: "secret-marker",
              },
            ],
          },
        })),
      },
    }
    const conn = { getClientAsync: mock(async () => client), getClient: mock(() => client) }
    const context = { subscriptions: [] }
    registerCommitMessageService(context as never, conn as never)
    return { client, conn, input, handler: cmds.mock.calls.at(-1)?.[1] }
  }

  it("prepares against the matched repo and sends frozen model plus explicit account context", async () => {
    pick.mockImplementation(async (items) => items[0])
    const { client, conn, input, handler } = setup()
    await handler?.({ rootUri: { fsPath: "/repo" } })

    expect(conn.getClientAsync).toHaveBeenCalledWith("/repo")
    expect(client.commitMessage.prepare).toHaveBeenCalledWith({ directory: "/repo" }, { throwOnError: true })
    expect(client.providerAccounts.list).toHaveBeenCalledWith({ provider: "openai", directory: "/repo" })
    expect(client.commitMessage.generate.mock.calls[0]?.[0]).toMatchObject({
      path: "/repo",
      model: { providerID: "openai", modelID: "gpt-4.1-mini" },
      accountContext: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "account-id" },
    })
    expect(JSON.stringify(pick.mock.calls[0]?.[0])).not.toContain("secret-marker")
    expect(input.value).toBe("feat: generated")
  })

  it("cancels after prepare without issuing generation", async () => {
    pick.mockResolvedValue(undefined)
    const { client, handler, input } = setup()
    await handler?.({ rootUri: { fsPath: "/repo" } })
    expect(client.commitMessage.prepare).toHaveBeenCalledTimes(1)
    expect(client.commitMessage.generate).not.toHaveBeenCalled()
    expect(input.value).toBe("")
  })

  it("rejects a backend identity change after selection", async () => {
    pick.mockImplementation(async (items) => items[0])
    const { client, conn, handler } = setup()
    conn.getClient.mockReturnValue({} as never)
    await handler?.({ rootUri: { fsPath: "/repo" } })
    expect(client.commitMessage.generate).not.toHaveBeenCalled()
    expect(shown).toContain("The Kilo backend reconnected. Retry generation to confirm account authority.")
  })

  it("never falls back to another repository for an unmatched SCM source", async () => {
    const { conn, handler } = setup()
    await handler?.({ rootUri: { fsPath: "/other" } })
    expect(conn.getClientAsync).not.toHaveBeenCalled()
    expect(shown).toContain("No Git repository found")
  })
})
