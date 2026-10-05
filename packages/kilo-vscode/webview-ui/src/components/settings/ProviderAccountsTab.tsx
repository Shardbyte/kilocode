import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useVSCode } from "../../context/vscode"
import { useSession } from "../../context/session"
import type {
  ExtensionMessage,
  ProviderAccount,
  ProviderAccountBinding,
  ProviderAccountUsage,
} from "../../types/messages"
import { canAssignBinding, canRepair, isCurrentSessionResponse, sessionTarget } from "../../../../src/provider-accounts"

const ProviderAccountsTab: Component = () => {
  const vscode = useVSCode()
  const session = useSession()
  const dialog = useDialog()
  const [accounts, setAccounts] = createSignal<ProviderAccount[]>([])
  const [binding, setBinding] = createSignal<ProviderAccountBinding | null>()
  const [usage, setUsage] = createSignal<Record<string, ProviderAccountUsage>>({})
  const [label, setLabel] = createSignal("")
  const [available, setAvailable] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [bindingStatus, setBindingStatus] = createSignal<"loading" | "ready" | "error" | "no-session">("loading")
  const sid = () => session.currentSessionID()
  const send = (
    action:
      | "list"
      | "add"
      | "rename"
      | "default"
      | "remove"
      | "reauth"
      | "usage"
      | "refreshUsage"
      | "binding"
      | "assign",
    id?: string,
    revision?: number,
    name?: string,
    confirmRepair = false,
    ctx?: { sessionID: string | undefined },
  ) => {
    setError(undefined)
    setLoading(true)
    vscode.postMessage({
      type: "providerAccounts",
      action,
      id,
      revision,
      label: name,
      sessionID: ctx ? ctx.sessionID : sid(),
      confirmRepair,
    })
  }
  const onMessage = (message: ExtensionMessage) => {
    if (message.type !== "providerAccountsLoaded") return
    if (!isCurrentSessionResponse(message.sessionID, sid())) return
    setAccounts(message.accounts)
    setAvailable(message.available)
    setBinding(message.binding)
    setBindingStatus(message.bindingStatus ?? "error")
    setError(message.error)
    setLoading(false)
    if (message.usage && typeof message.usage.snapshot === "object") {
      setUsage((current) => ({ ...current, [message.usage!.accountID]: message.usage! }))
    }
  }
  const off = vscode.onMessage(onMessage)
  let prev = sid()
  createEffect(() => {
    const current = sid()
    if (current !== prev) {
      prev = current
      dialog.close()
    }
    setAccounts([])
    setBinding(undefined)
    setBindingStatus(current ? "loading" : "no-session")
    setUsage({})
    send("list")
  })
  onCleanup(off)
  const unbound = () => canAssignBinding(bindingStatus(), binding())
  const boundID = () => {
    const value = binding()
    return value?.mode === "profile" ? value.profileID : undefined
  }
  const missingBound = () => {
    const value = binding()
    return bindingStatus() === "ready" && canRepair(value, new Set(accounts().map((account) => account.id)))
  }
  const assign = (target: ReturnType<typeof sessionTarget>, accountID: string, repair = false) => {
    if (bindingStatus() !== "ready" || !target.isCurrent()) {
      setError("The active session changed or its provider binding could not be loaded. Refresh before assigning.")
      return
    }
    send("assign", accountID, undefined, undefined, repair, { sessionID: target.id })
  }
  const confirm = (title: string, text: string, action: () => void) => {
    dialog.show(() => (
      <Dialog title={title} fit>
        <div class="dialog-confirm-body">
          <p>{text}</p>
          <div class="dialog-confirm-actions">
            <Button variant="secondary" onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              class="danger-btn"
              onClick={() => {
                dialog.close()
                action()
              }}
            >
              Confirm
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }
  const edit = (account: ProviderAccount) => {
    const [name, setName] = createSignal(account.label)
    dialog.show(() => (
      <Dialog title="Rename provider account" fit>
        <TextField label="Account label" value={name()} onChange={setName} />
        <div class="dialog-confirm-actions">
          <Button variant="secondary" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name().trim()}
            onClick={() => {
              dialog.close()
              send("rename", account.id, undefined, name().trim())
            }}
          >
            Save
          </Button>
        </div>
      </Dialog>
    ))
  }
  return (
    <Card>
      <p>Manage local OpenAI OAuth profiles. Credentials stay in the backend.</p>
      <Show when={!available()}>
        <p>Provider account profiles are unavailable in this backend.</p>
      </Show>
      <Show when={error()}>{(value) => <p role="alert">{value()}</p>}</Show>
      <Button variant="secondary" disabled={loading()} onClick={() => send("list")}>
        Refresh accounts
      </Button>
      <Show when={available()}>
        <div>
          <TextField label="Account label" value={label()} onChange={setLabel} />
          <Button
            variant="primary"
            disabled={!label().trim() || loading()}
            onClick={() => send("add", undefined, undefined, label().trim())}
          >
            Add OAuth account
          </Button>
        </div>
        <Show when={sid()} fallback={<p>Open a session to view or assign its provider account.</p>}>
          <p>
            <strong>Used by this session: </strong>
            {binding()?.mode === "profile"
              ? (accounts().find((account) => account.id === boundID())?.label ?? "Unavailable profile")
              : unbound()
                ? "Unbound"
                : binding()?.mode === "legacy"
                  ? "Legacy provider authentication"
                  : bindingStatus() === "error"
                    ? "Could not load provider binding. Refresh and retry."
                    : bindingStatus() === "no-session"
                      ? "No active session"
                      : "Loading"}
          </p>
          <Show when={unbound()}>
            <p>Choose a profile to bind this session. This does not change its binding unless you select one.</p>
          </Show>
          <Show when={missingBound()}>
            <p>
              This session's bound profile is absent from the successfully loaded account list. Credentials marked
              missing are not considered an unavailable profile.
            </p>
          </Show>
        </Show>
        <For each={accounts()}>
          {(account) => {
            const mayAssign = () => unbound() || (missingBound() && binding()?.mode === "profile")
            const current = () => boundID() === account.id
            const data = () => usage()[account.id]
            return (
              <section>
                <strong>{account.label}</strong> <span>{account.authState}</span>
                <Show when={account.isDefault}>
                  <span> Default for new sessions</span>
                </Show>
                <div>
                  <Show when={!account.isDefault}>
                    <Button variant="secondary" onClick={() => send("default", account.id)}>
                      Default for new sessions
                    </Button>
                  </Show>
                  <Button
                    variant="secondary"
                    disabled={account.revision == null}
                    onClick={() => send("reauth", account.id, account.revision)}
                  >
                    Reauthenticate
                  </Button>
                  <Button variant="secondary" onClick={() => send("usage", account.id)}>
                    Usage
                  </Button>
                  <Button variant="secondary" onClick={() => send("refreshUsage", account.id)}>
                    Refresh usage
                  </Button>
                  <Button variant="secondary" onClick={() => edit(account)}>
                    Rename
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      confirm(
                        "Remove provider account?",
                        `Remove ${account.label} and its local credential? Existing session bindings may become unavailable.`,
                        () => send("remove", account.id),
                      )
                    }
                  >
                    Remove
                  </Button>
                  <Show when={sid() && mayAssign() && !current() && account.authState !== "missing"}>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const target = sessionTarget(sid(), sid)
                        if (!target.id || !target.isCurrent()) return
                        if (missingBound()) {
                          confirm(
                            "Repair session profile?",
                            `Replace the unavailable session profile with ${account.label}? The backend will validate repair eligibility and conflicts.`,
                            () => assign(target, account.id, true),
                          )
                          return
                        }
                        assign(target, account.id)
                      }}
                    >
                      {missingBound() ? "Repair for this session" : "Use for this session"}
                    </Button>
                  </Show>
                  <Show when={current()}>
                    <span>Used by this session</span>
                  </Show>
                </div>
                <Show when={data()}>
                  {(item) => (
                    <div>
                      <p>
                        Usage as of {new Date(item().retrievedAt).toLocaleString()} · {item().snapshot.planLabel}
                      </p>
                      <Show when={item().snapshot.fetchState !== "ready"}>
                        <p>Usage data is {item().snapshot.fetchState}.</p>
                      </Show>
                      <For each={item().snapshot.windows}>
                        {(window) => (
                          <p>
                            {window.id} ({window.resource}):{" "}
                            {window.orientation === "remaining_percent"
                              ? (window.remaining ?? "Unknown")
                              : (window.used ?? "Unknown")}
                            {window.orientation.endsWith("percent") ? "%" : ` ${window.unit}`}
                            {window.orientation === "remaining_percent" ? " remaining" : " used"}
                            {window.limit == null || window.orientation.endsWith("percent")
                              ? ""
                              : ` / ${window.limit}`}{" "}
                            {window.state}
                            {window.durationMs == null ? "" : ` · ${window.durationMs / 3_600_000} hour window`}
                            {window.resetAt ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ""}
                          </p>
                        )}
                      </For>
                    </div>
                  )}
                </Show>
              </section>
            )
          }}
        </For>
      </Show>
    </Card>
  )
}

export default ProviderAccountsTab
