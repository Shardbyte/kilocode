import type { Argv } from "yargs"
import { cmd } from "@/cli/cmd/cmd"
import type { KiloClient } from "@kilocode/sdk/v2"

class Failure extends Error {}

function options<T>(yargs: Argv<T>) {
  return yargs
    .option("json", { describe: "output as JSON", type: "boolean", default: false })
    .option("directory", { describe: "project directory for this operation", type: "string" })
}

function unwrap(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  if ("error" in value && value.error) throw error(value.error)
  if (!("data" in value)) return value
  return value.data
}

function error(err: unknown) {
  const code = typeof err === "object" && err !== null && "error" in err ? String(err.error) : ""
  const messages: Record<string, string> = {
    Disabled: "Enable KILO_EXPERIMENTAL_PROVIDER_PROFILES on the backend to manage provider accounts",
    NotFound: "Provider account or session was not found",
    Conflict:
      "Provider account conflict; a turn may be running, credentials may have changed, or the binding is not eligible for recovery",
    Duplicate: "That label or remote account already has a local profile",
    IdentityMismatch: "Reauthentication returned a different remote account",
    InvalidRequest: "The provider account operation is invalid or the binding is not eligible for recovery",
    OAuthFailed: "OAuth did not complete; the provider account was not updated",
    StorageFailed: "Provider account storage is unavailable; retry later",
  }
  return new Failure(messages[code] ?? "Provider account request failed")
}

async function run(args: Record<string, unknown>, action: (sdk: KiloClient) => Promise<unknown>) {
  const [{ Server }, { ServerAuth }, { createKiloClient }] = await Promise.all([
    import("@/server/server"),
    import("@/server/auth"),
    import("@kilocode/sdk/v2"),
  ])
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const sdk = createKiloClient({ baseUrl: `http://${server.hostname}:${server.port}`, headers: ServerAuth.headers() })
    const value = await action(sdk).then(unwrap)
    if (args.json) console.log(JSON.stringify(value, null, 2))
    else if (value !== undefined) console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
  } catch (err) {
    if (err instanceof Failure) throw err
    throw new Failure("Provider account request failed")
  } finally {
    await server.stop(true)
  }
}

function str(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (typeof value !== "string") throw new Failure(`Missing ${key}`)
  return value
}

function dir(args: Record<string, unknown>) {
  return typeof args.directory === "string" ? args.directory : process.cwd()
}

function action(
  name: string,
  describe: string,
  perform: (args: Record<string, unknown>, sdk: KiloClient) => Promise<unknown>,
) {
  return cmd({
    command: name,
    describe,
    builder: (yargs) => options(yargs),
    handler: async (args) => run(args, (sdk) => perform(args, sdk)),
  })
}

async function oauth(sdk: KiloClient, op: { operationID: string; url: string }, directory: string) {
  const url = URL.parse(op.url)
  const cancel = async () => {
    const result = await sdk.providerAccounts.oauth
      .cancel({ operationID: op.operationID, directory })
      .catch(() => undefined)
    if (result == null || result.error)
      console.error("OAuth cancellation could not be confirmed; the operation will expire")
  }
  const abort = () => void cancel().finally(() => process.exit(130))
  process.once("SIGINT", abort)
  try {
    if (
      !url ||
      url.protocol !== "https:" ||
      url.hostname !== "auth.openai.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/oauth/authorize" ||
      ["access_token", "refresh_token", "token", "cookie"].some((key) => url.searchParams.has(key))
    )
      throw new Failure("Provider returned an unsupported OAuth authorization URL")
    console.error(`Authorize this account: ${url.href}`)
    const { default: open } = await import("open")
    await open(url.href).catch(() => console.error("Browser launch failed; open the authorization URL manually"))
    const result = await sdk.providerAccounts.oauth.complete({ operationID: op.operationID, directory })
    return unwrap(result)
  } catch (err) {
    await cancel()
    // Never print transport bodies or OAuth exchange errors.
    if (err instanceof Failure) throw err
    throw new Failure("OAuth did not complete; the provider account was not updated")
  } finally {
    process.removeListener("SIGINT", abort)
  }
}

const List = action("list", "list saved provider accounts", async (_args, sdk) => {
  const result = await sdk.providerAccounts.list({ provider: "openai", directory: dir(_args) })
  if (result.error) throw error(result.error)
  return result.data
})
const Add = cmd({
  command: ["add <label>", "login <label>"],
  describe: "add a provider account with OAuth",
  builder: (yargs) => options(yargs),
  handler: async (args) =>
    run(args, async (sdk) => {
      const started = await sdk.providerAccounts.oauth.start({ label: str(args, "label"), directory: dir(args) })
      if (started.error) throw error(started.error)
      return oauth(sdk, started.data, dir(args))
    }),
})
const Default = action("default <account>", "select the default for new sessions", (args, sdk) =>
  sdk.providerAccounts.default.select({ providerID: "openai", accountID: str(args, "account"), directory: dir(args) }),
)
const Rename = action("rename <account> <label>", "rename a provider account", (args, sdk) =>
  sdk.providerAccounts.rename({ accountID: str(args, "account"), label: str(args, "label"), directory: dir(args) }),
)
const Usage = action("usage <account>", "show cached provider account usage", (args, sdk) =>
  sdk.providerAccounts.usage.get({ accountID: str(args, "account"), directory: dir(args) }),
)
const Refresh = action("refresh <account>", "refresh provider account usage", (args, sdk) =>
  sdk.providerAccounts.usage.refresh({ accountID: str(args, "account"), directory: dir(args) }),
)
const AuthState = action("auth-state <account>", "show provider account credential health", (args, sdk) =>
  sdk.providerAccounts.authState({ accountID: str(args, "account"), directory: dir(args) }),
)
const Reauth = action("reauth <account>", "reauthenticate a provider account", async (args, sdk) => {
  const current = await sdk.providerAccounts.get({ accountID: str(args, "account"), directory: dir(args) })
  if (current.error) throw error(current.error)
  if (current.data.revision == null)
    throw new Failure("Provider account has no credential revision; reauthentication cannot begin")
  const started = await sdk.providerAccounts.oauth.reauthenticate({
    accountID: str(args, "account"),
    expectedRevision: current.data.revision,
    directory: dir(args),
  })
  if (started.error) throw error(started.error)
  return oauth(sdk, started.data, dir(args))
})
const Remove = cmd({
  command: "remove <account>",
  describe: "remove a provider account",
  builder: (yargs) =>
    options(yargs).option("yes", { describe: "explicitly confirm removal without a prompt", type: "boolean" }),
  handler: async (args) =>
    run(args, async (sdk) => {
      const { confirm } = await import("@clack/prompts")
      const account = str(args, "account")
      if (!args.yes && (await confirm({ message: `Remove provider account ${account}?` })) !== true) return "Canceled"
      const result = await sdk.providerAccounts.remove({ accountID: account, directory: dir(args) })
      if (result.error) throw error(result.error)
      return result.data
    }),
})
const SessionGet = action("session <session>", "inspect a session provider account binding", (args, sdk) =>
  sdk.providerAccounts.session.get({ sessionID: str(args, "session"), providerID: "openai", directory: dir(args) }),
)
const SessionAssign = cmd({
  command: "assign <session> <account>",
  describe: "assign a provider account to a session",
  builder: (yargs) =>
    options(yargs)
      .option("repair", { describe: "request repair of an unavailable binding", type: "boolean" })
      .option("yes", { describe: "explicitly confirm unavailable-account repair without a prompt", type: "boolean" }),
  handler: async (args) =>
    run(args, async (sdk) => {
      const binding = await sdk.providerAccounts.session.get({
        sessionID: str(args, "session"),
        providerID: "openai",
        directory: dir(args),
      })
      if (binding.error) throw error(binding.error)
      const list = await sdk.providerAccounts.list({ provider: "openai", directory: dir(args) })
      if (list.error) throw error(list.error)
      const profileID = binding.data?.mode === "profile" ? binding.data.profileID : undefined
      const unavailable = profileID != null && !list.data.accounts.some((account) => account.id === profileID)
      if (unavailable && !args.repair)
        throw new Failure("Existing session account is unavailable; rerun with --repair to confirm replacement")
      if (unavailable && args.repair && !args.yes) {
        const { confirm } = await import("@clack/prompts")
        if ((await confirm({ message: "Replace the unavailable account binding?" })) !== true) return "Canceled"
      }
      const assigned = await sdk.providerAccounts.session.assign({
        sessionID: str(args, "session"),
        providerID: "openai",
        accountID: str(args, "account"),
        directory: dir(args),
        ...(unavailable ? { confirmRepair: true } : {}),
      })
      if (assigned.error) throw error(assigned.error)
      return assigned.data
    }),
})

export const AccountsCommand = cmd({
  command: "accounts",
  describe: "manage provider account profiles",
  builder: (yargs: Argv) =>
    yargs
      .command(List)
      .command(Add)
      .command(Default)
      .command(Rename)
      .command(Usage)
      .command(Refresh)
      .command(AuthState)
      .command(Reauth)
      .command(Remove)
      .command(SessionGet)
      .command(SessionAssign)
      .demandCommand(),
  handler: async () => {},
})
