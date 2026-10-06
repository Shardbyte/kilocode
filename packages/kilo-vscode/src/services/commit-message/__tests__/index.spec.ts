import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"

// Mock vscode following the pattern from AutocompleteServiceManager.spec.ts
vi.mock("vscode", () => {
  const disposable = { dispose: vi.fn() }

  return {
    commands: {
      registerCommand: vi.fn((_command: string, _callback: (...args: any[]) => any) => disposable),
    },
    window: {
      showErrorMessage: vi.fn(),
      showQuickPick: vi.fn(),
      withProgress: vi.fn(),
    },
    workspace: {
      workspaceFolders: [
        {
          uri: { fsPath: "/test/workspace" },
        },
      ],
      getConfiguration: vi.fn(() => ({ get: () => undefined })),
    },
    env: { language: "en" },
    extensions: {
      getExtension: vi.fn(),
    },
    ProgressLocation: {
      SourceControl: 1,
    },
    Uri: {
      parse: (s: string) => ({ fsPath: s }),
    },
  }
})

import * as vscode from "vscode"
import { registerCommitMessageService } from "../index"
import type { KiloConnectionService } from "../../cli-backend/connection-service"

describe("commit-message service", () => {
  let mockContext: vscode.ExtensionContext
  let mockConnectionService: KiloConnectionService
  let mockClient: { commitMessage: { prepare: Mock; generate: Mock }; providerAccounts: { list: Mock } }

  beforeEach(() => {
    vi.clearAllMocks()

    mockContext = {
      subscriptions: [],
    } as any

    mockClient = {
      commitMessage: {
        prepare: vi.fn().mockResolvedValue({
          data: {
            model: { providerID: "openai", modelID: "gpt-4.1-mini" },
            profilesEnabled: false,
            requiresAccountContext: false,
            allowedContextKinds: [],
          },
        }),
        generate: vi.fn().mockResolvedValue({ data: { message: "feat: add new feature" } }),
      },
      providerAccounts: { list: vi.fn().mockResolvedValue({ data: { accounts: [] } }) },
    }

    mockConnectionService = {
      getClientAsync: vi.fn().mockResolvedValue(mockClient),
      getClient: vi.fn().mockReturnValue(mockClient),
    } as any
  })

  describe("registerCommitMessageService", () => {
    it("returns an array of disposables", () => {
      const disposables = registerCommitMessageService(mockContext, mockConnectionService)

      expect(Array.isArray(disposables)).toBe(true)
      expect(disposables.length).toBeGreaterThan(0)
    })

    it("registers the kilo-code.new.generateCommitMessage command", () => {
      registerCommitMessageService(mockContext, mockConnectionService)

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "kilo-code.new.generateCommitMessage",
        expect.any(Function),
      )
    })

    it("pushes the command disposable to context.subscriptions", () => {
      registerCommitMessageService(mockContext, mockConnectionService)

      expect(mockContext.subscriptions.length).toBe(1)
    })
  })

  describe("command execution", () => {
    let commandCallback: (...args: any[]) => Promise<void>

    beforeEach(() => {
      registerCommitMessageService(mockContext, mockConnectionService)

      // Extract the registered command callback
      const registerCall = (vscode.commands.registerCommand as Mock).mock.calls[0]!
      commandCallback = registerCall[1] as (...args: any[]) => Promise<void>
    })

    it("shows error when git extension is not found", async () => {
      ;(vscode.extensions.getExtension as Mock).mockReturnValue(undefined)

      await commandCallback()

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Git extension not found")
    })

    it("shows error when no git repository is found", async () => {
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({ repositories: [] }),
        },
      })

      await commandCallback()

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Git repository found")
    })

    it("shows error when backend fails to connect", async () => {
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [{ inputBox: { value: "" }, rootUri: { fsPath: "/repo" } }],
          }),
        },
      })
      ;(mockConnectionService.getClientAsync as Mock).mockRejectedValue(new Error("Connect failed"))

      await commandCallback()

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "Failed to connect to Kilo backend. Please try again.",
      )
    })

    it("auto-connects backend and generates message when client not yet ready", async () => {
      const mockInputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [{ inputBox: mockInputBox, rootUri: { fsPath: "/auto-connect-repo" } }],
          }),
        },
      })

      const mockToken = { onCancellationRequested: vi.fn() }
      ;(vscode.window.withProgress as Mock).mockImplementation(async (_options: any, task: any) => {
        await task({}, mockToken)
      })

      await commandCallback()

      expect(mockConnectionService.getClientAsync).toHaveBeenCalled()
      expect(mockInputBox.value).toBe("feat: add new feature")
    })

    it("calls commitMessage.generate on the SDK client with repository root path", async () => {
      const mockInputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [{ inputBox: mockInputBox, rootUri: { fsPath: "/repo" } }],
          }),
        },
      })

      const mockToken = { onCancellationRequested: vi.fn() }
      ;(vscode.window.withProgress as Mock).mockImplementation(async (_options: any, task: any) => {
        await task({}, mockToken)
      })

      await commandCallback()

      expect(mockClient.commitMessage.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/repo",
          selectedFiles: undefined,
          previousMessage: undefined,
          model: { providerID: "openai", modelID: "gpt-4.1-mini" },
        }),
        expect.objectContaining({ throwOnError: true }),
      )
    })

    it("sets the generated message on the repository inputBox", async () => {
      const mockInputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [{ inputBox: mockInputBox, rootUri: { fsPath: "/repo" } }],
          }),
        },
      })

      const mockToken = { onCancellationRequested: vi.fn() }
      ;(vscode.window.withProgress as Mock).mockImplementation(async (_options: any, task: any) => {
        await task({}, mockToken)
      })

      await commandCallback()

      expect(mockInputBox.value).toBe("feat: add new feature")
    })

    it("shows cancellable progress in SourceControl location", async () => {
      const mockInputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [{ inputBox: mockInputBox, rootUri: { fsPath: "/repo" } }],
          }),
        },
      })

      const mockToken = { onCancellationRequested: vi.fn() }
      ;(vscode.window.withProgress as Mock).mockImplementation(async (_options: any, task: any) => {
        await task({}, mockToken)
      })

      await commandCallback()

      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          location: vscode.ProgressLocation.SourceControl,
          title: "Generating commit message...",
          cancellable: true,
        }),
        expect.any(Function),
      )
    })

    it("uses the matching repository when SourceControl arg is provided", async () => {
      const mainInputBox = { value: "" }
      const worktreeInputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [
              { inputBox: mainInputBox, rootUri: { fsPath: "/main-repo" } },
              { inputBox: worktreeInputBox, rootUri: { fsPath: "/worktree-repo" } },
            ],
          }),
        },
      } as any)
      ;(vscode.window.withProgress as Mock).mockImplementation(async (_options, task) => {
        await task({} as any, { onCancellationRequested: vi.fn() } as any)
      })

      // Simulate SCM title/input passing the SourceControl for the worktree repo
      const scmArg = { rootUri: { fsPath: "/worktree-repo" } } as vscode.SourceControl
      await commandCallback(scmArg)

      // The worktree repo's inputBox should be updated, not the main repo's
      expect(worktreeInputBox.value).toBe("feat: add new feature")
      expect(mainInputBox.value).toBe("")
    })

    it("does not generate for a SourceControl repo outside the repository list", async () => {
      const mainInputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: {
          getAPI: () => ({
            repositories: [{ inputBox: mainInputBox, rootUri: { fsPath: "/main-repo" } }],
          }),
        },
      } as any)
      ;(vscode.window.withProgress as Mock).mockImplementation(async (_options, task) => {
        await task({} as any, { onCancellationRequested: vi.fn() } as any)
      })

      const scmArg = { rootUri: { fsPath: "/nonexistent-repo" } } as vscode.SourceControl
      await commandCallback(scmArg)

      expect(mainInputBox.value).toBe("")
      expect(mockConnectionService.getClientAsync).not.toHaveBeenCalled()
    })

    it("does not fall back to generate when an older backend has no prepare endpoint", async () => {
      const inputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: { getAPI: () => ({ repositories: [{ inputBox, rootUri: { fsPath: "/old-backend" } }] }) },
      } as any)
      mockClient.commitMessage.prepare.mockRejectedValue(new Error("HTTP 404"))

      await commandCallback()

      expect(mockClient.commitMessage.generate).not.toHaveBeenCalled()
      expect(vscode.window.withProgress).not.toHaveBeenCalled()
      expect(inputBox.value).toBe("")
    })

    it("does not execute a picked account context after the backend reconnects", async () => {
      const inputBox = { value: "" }
      ;(vscode.extensions.getExtension as Mock).mockReturnValue({
        isActive: true,
        activate: vi.fn().mockResolvedValue(undefined),
        exports: { getAPI: () => ({ repositories: [{ inputBox, rootUri: { fsPath: "/reconnect" } }] }) },
      } as any)
      mockClient.commitMessage.prepare.mockResolvedValue({
        data: {
          model: { providerID: "openai", modelID: "gpt-5-mini" },
          profilesEnabled: true,
          requiresAccountContext: true,
          allowedContextKinds: ["account"],
        },
      })
      mockClient.providerAccounts.list.mockResolvedValue({
        data: { accounts: [{ id: "acct-1", label: "Default", isDefault: true, authState: "ready" }] },
      })
      ;(vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: "Default",
        value: { kind: "account", providerID: "openai", authMode: "chatgpt-oauth", accountID: "acct-1" },
      } as any)
      ;(mockConnectionService.getClient as Mock).mockReturnValue({} as any)

      await commandCallback()

      expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1)
      expect(mockClient.commitMessage.generate).not.toHaveBeenCalled()
      expect(vscode.window.withProgress).not.toHaveBeenCalled()
      expect(inputBox.value).toBe("")
    })
  })
})
