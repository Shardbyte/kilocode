import * as vscode from "vscode"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { getCommitMessageLanguage } from "../i18n"
import { accountDTOs } from "../../provider-accounts"
import { selectUtilityAccount } from "../utility-account"

let lastGeneratedMessage: string | undefined
let lastWorkspacePath: string | undefined

interface GitRepository {
  inputBox: { value: string }
  rootUri: vscode.Uri
}

interface GitAPI {
  repositories: GitRepository[]
}

interface GitExtensionExports {
  getAPI(version: number): GitAPI
}

function findRepository(repositories: GitRepository[], arg?: vscode.SourceControl): GitRepository | undefined {
  if (!repositories.length) return undefined
  if (arg?.rootUri) {
    const target = arg.rootUri.fsPath
    const match = repositories.find((r) => r.rootUri.fsPath === target)
    if (match) return match
    return undefined
  }
  return repositories[0]
}

export function registerCommitMessageService(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
): vscode.Disposable[] {
  const command = vscode.commands.registerCommand(
    "kilo-code.new.generateCommitMessage",
    async (arg?: vscode.SourceControl) => {
      const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git")
      if (!extension) {
        vscode.window.showErrorMessage("Git extension not found")
        return
      }

      if (!extension.isActive) {
        await extension.activate()
      }

      const git = extension.exports?.getAPI(1)
      const repository = findRepository(git?.repositories ?? [], arg)
      if (!repository) {
        vscode.window.showErrorMessage("No Git repository found")
        return
      }

      const path = repository.rootUri.fsPath

      let client
      try {
        client = await connectionService.getClientAsync(path)
      } catch {
        vscode.window.showErrorMessage("Failed to connect to Kilo backend. Please try again.")
        return
      }

      const previousMessage = lastWorkspacePath === path ? lastGeneratedMessage : undefined

      const prepared = await client.commitMessage
        .prepare({ directory: path }, { throwOnError: true })
        .catch(() => undefined)
      if (!prepared?.data) {
        vscode.window.showErrorMessage("Could not prepare commit message generation. Please try again.")
        return
      }
      const plan = prepared.data
      const accountContext = plan.requiresAccountContext
        ? await (async () => {
            const listed = await client.providerAccounts
              .list({ provider: "openai", directory: path })
              .catch(() => undefined)
            return selectUtilityAccount(accountDTOs(listed?.data?.accounts), plan.allowedContextKinds)
          })()
        : undefined
      if (plan.requiresAccountContext && !accountContext) return
      try {
        if (connectionService.getClient() !== client) {
          vscode.window.showErrorMessage("The Kilo backend reconnected. Retry generation to confirm account authority.")
          return
        }
      } catch {
        vscode.window.showErrorMessage("The Kilo backend reconnected. Retry generation to confirm account authority.")
        return
      }

      let userCancelled = false
      let timedOut = false
      const controller = new AbortController()

      await vscode.window
        .withProgress(
          {
            location: vscode.ProgressLocation.SourceControl,
            title: "Generating commit message...",
            cancellable: true,
          },
          async (_progress, token) => {
            // Wire VS Code cancellation to abort the HTTP request
            token.onCancellationRequested(() => {
              userCancelled = true
              controller.abort()
            })

            // Client-side safety timeout (35s) — slightly longer than the
            // server-side 30s timeout so the server can respond with a proper
            // error first, but still ensures the spinner never hangs forever.
            const timeout = 35_000
            const timer = setTimeout(() => {
              timedOut = true
              controller.abort()
            }, timeout)

            try {
              const { data } = await client.commitMessage.generate(
                {
                  path,
                  selectedFiles: undefined,
                  previousMessage,
                  language: getCommitMessageLanguage(vscode),
                  model: plan.model,
                  ...(accountContext ? { accountContext } : {}),
                },
                { throwOnError: true, signal: controller.signal },
              )
              const message = data.message
              repository.inputBox.value = message
              lastGeneratedMessage = message
              lastWorkspacePath = path
              console.log("[Kilo New] Commit message generated successfully")
            } finally {
              clearTimeout(timer)
            }
          },
        )
        .then(undefined, () => {
          if (userCancelled) {
            console.log("[Kilo New] Commit message generation was cancelled by user")
            return
          }
          if (timedOut) {
            console.log("[Kilo New] Commit message generation timed out")
            vscode.window.showErrorMessage("Commit message generation timed out. Please try again.")
            return
          }
          console.error("[Kilo New] Failed to generate commit message")
          vscode.window.showErrorMessage("Could not generate commit message. Check account selection and retry.")
        })
    },
  )

  context.subscriptions.push(command)
  return [command]
}
