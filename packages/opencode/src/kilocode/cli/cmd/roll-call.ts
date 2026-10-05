import type { Argv } from "yargs"
import type { Provider } from "../../../provider/provider"
import type { generateText } from "ai"
import { ProviderTransform } from "../../../provider/transform"
import { cmd } from "../../../cli/cmd/cmd"
import { UI } from "../../../cli/ui"
import { randomUUID } from "crypto"
import { pick as pickAccount } from "@/kilocode/cli/utility-account"
import type { UtilityAccount } from "@/kilocode/provider/utility-account"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"

// Keep the top-level import graph light: this module is registered eagerly at CLI
// startup, so implementation dependencies (provider service, AppRuntime, the `ai`
// SDK) are imported lazily (same deferral pattern as upstream opencode#30453).
// Resolved once per process: roll-call's per-model path must not re-await import
// resolution for every model.
let cache: ReturnType<typeof loadDeps> | undefined
function loadDeps() {
  return Promise.all([
    import("../../../effect/app-runtime"),
    import("../../../provider/provider"),
    import("../../../effect/runtime-flags"),
    import("../../../kilocode/provider/utility-account"),
    import("ai"),
    import("../../provider/opencode-session-headers"),
  ]).then(([runtime, provider, flags, utility, ai, headers]) => ({
    AppRuntime: runtime.AppRuntime,
    Provider: provider.Provider,
    RuntimeFlags: flags.RuntimeFlags,
    UtilityAccount: utility.UtilityAccount,
    generateText: ai.generateText,
    opencodeSessionHeaders: headers.opencodeSessionHeaders,
  }))
}
function deps() {
  cache ??= loadDeps()
  return cache
}

const HEADERS = ["Model", "Access", "Snippet", "Latency"]
const PADDING = 9

export function probeContext(providerID: string, context: UtilityAccount.Context | undefined) {
  return providerID === "openai" ? context : undefined
}

export function invalidContext(targets: string[], explicit: boolean) {
  return explicit && !targets.includes("openai")
}

const tty = process.stderr.isTTY ?? false

function color(style: string): string {
  return tty ? style : ""
}

function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-(?:proj-)?|sess-|eyJ)[A-Za-z0-9._~-]{12,}/g, "[redacted]")
    .replace(/((?:access|refresh)_token["'=:\s]+)[^\s,"'}]+/gi, "$1[redacted]")
}

function truncate(text: string, max: number): string {
  if (max < 4) return text.substring(0, max)
  return text.length > max ? text.substring(0, max - 3) + "..." : text
}

export function formatTable(rows: string[][], width: number): { header: string; separator: string; rows: string[] } {
  const clean = rows.map((row) => row.map((cell) => sanitize(cell ?? "")))
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...clean.map((row) => row[i].length)))
  const total = widths.reduce((sum, item) => sum + item, 0) + PADDING
  const min = HEADERS[2].length + 3

  if (total > width && widths[2] > min) {
    const overflow = total - width
    widths[2] = Math.max(min, widths[2] - overflow)
  }

  const header = HEADERS.map((h, i) => h.padEnd(widths[i])).join(" | ")
  const separator = "-".repeat(header.length)
  const body = clean.map((row) => {
    const current = [row[0], row[1], row[2] ? truncate(row[2], widths[2]) : row[2], row[3]]
    return current.map((cell, i) => cell.padEnd(widths[i])).join(" | ")
  })

  return { header, separator, rows: body }
}

export function formatMarkdown(rows: string[][]): string {
  const escaped = rows.map((row) => row.map((cell) => sanitize(cell ?? "").replace(/\|/g, "\\|")))
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...escaped.map((row) => row[i].length)))
  const pad = (text: string, i: number) => text.padEnd(widths[i])
  const header = "| " + HEADERS.map((h, i) => pad(h, i)).join(" | ") + " |"
  const separator = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |"
  const body = escaped.map((row) => "| " + row.map((cell, i) => pad(cell, i)).join(" | ") + " |")

  return [header, separator, ...body].join("\n")
}

export function isTextModel(model: Provider.Model): boolean {
  return model.capabilities.input.text && model.capabilities.output.text
}

export const RollCallCommand = cmd({
  command: "roll-call <filter>",
  describe: "batch-test text models matching a filter for connectivity and latency",
  builder: (yargs: Argv) => {
    return yargs
      .positional("filter", {
        type: "string",
        describe: "regex to filter models by provider/modelID (required)",
        demandOption: true,
      })
      .option("prompt", {
        type: "string",
        default: "Hello",
        describe: "Prompt to send to each model",
      })
      .option("timeout", {
        type: "number",
        default: 25000,
        describe: "Timeout for each model call in milliseconds",
      })
      .option("parallel", {
        type: "number",
        default: 5,
        describe: "Number of parallel model calls",
      })
      .option("verbose", {
        type: "boolean",
        default: false,
        describe: "Show verbose output",
      })
      .option("quiet", {
        type: "boolean",
        default: false,
        describe: "Suppress progress and decoration",
      })
      .option("account", { type: "string", describe: "OpenAI account ID for matching OpenAI models" })
      .option("legacy-auth", { type: "boolean", default: false, describe: "use legacy OpenAI authentication" })
      .option("output", {
        type: "string",
        choices: ["table", "json", "md"],
        default: "table",
        describe: "Output format (table, json, or md)",
      })
  },
  handler: async (args) => {
    await handle({
      prompt: args.prompt,
      timeout: args.timeout,
      filter: args.filter,
      parallel: args.parallel,
      output: args.output === "json" || args.output === "md" ? args.output : "table",
      verbose: args.verbose,
      quiet: args.quiet,
      account: args.account,
      legacyAuth: args["legacy-auth"],
    })
  },
})

interface Result {
  model: string
  access: boolean
  snippet: string
  latency: number | null
  errorType: string | null
  errorMessage: string | null
}

async function list() {
  const { AppRuntime, Provider } = await deps()
  return AppRuntime.runPromise(Provider.Service.use((svc) => svc.list()))
}

async function lang(model: Provider.Model) {
  const { AppRuntime, Provider } = await deps()
  return AppRuntime.runPromise(Provider.Service.use((svc) => svc.getLanguage(model)))
}

export function outputLimit(model: Provider.Model, outputTokenMax?: number) {
  return ProviderTransform.maxOutputTokens(model, outputTokenMax)
}

export async function handle(args: ArgumentsCamelCase) {
  const { provide } = await import("../../instance")
  const load = args.list ?? list

  if (args.parallel < 1) {
    UI.error("--parallel must be at least 1")
    process.exitCode = 1
    return
  }

  if (args.timeout < 1) {
    UI.error("--timeout must be at least 1")
    process.exitCode = 1
    return
  }

  if (!args.filter.trim()) {
    UI.error("filter is required and cannot be empty")
    process.exitCode = 1
    return
  }

  const json = args.output === "json"
  const structured = json || args.output === "md"

  if (!args.quiet && !structured) {
    UI.println(
      `${color(UI.Style.TEXT_INFO)}Starting roll call for models with prompt: "${args.prompt}"${color(UI.Style.TEXT_NORMAL)}`,
    )
    UI.println(
      `${color(UI.Style.TEXT_INFO)}Timeout per model: ${args.timeout}ms, Parallel calls: ${args.parallel}${color(UI.Style.TEXT_NORMAL)}`,
    )
  }

  await provide({
    directory: process.cwd(),
    async fn() {
      const providers = await load()
      const regex = (() => {
        try {
          return new RegExp(args.filter, "i")
        } catch (err) {
          UI.error(`Invalid filter regex: ${args.filter}`)
          process.exitCode = 1
          return undefined
        }
      })()
      if (!regex) return

      const models = Object.entries(providers).flatMap(([providerID, provider]) =>
        Object.entries(provider.models)
          .filter(([modelID, model]) => regex.test(`${providerID}/${modelID}`) && isTextModel(model))
          .map(([modelID, model]) => ({ providerID, modelID, model })),
      )

      if (
        invalidContext(
          models.map((item) => item.providerID),
          Boolean(args.account || args.legacyAuth),
        )
      ) {
        UI.error("OpenAI account context cannot be used for a filter with no OpenAI models")
        process.exitCode = 1
        return
      }
      if (args.account && args.legacyAuth) {
        UI.error("--account and --legacy-auth cannot be used together")
        process.exitCode = 1
        return
      }

      if (models.length === 0) {
        if (!args.quiet && !structured)
          UI.println(`${color(UI.Style.TEXT_WARNING)}No models to test after filtering.${color(UI.Style.TEXT_NORMAL)}`)
        if (json) console.log(JSON.stringify([], null, 2))
        if (args.output === "md") console.log(formatMarkdown([]))
        if (structured) return
        process.exitCode = 1
        return
      }

      const { AppRuntime, UtilityAccount } = await deps()
      const context = models.some((item) => item.providerID === "openai")
        ? await pickAccount({
            accounts: ProviderAccountProfiles.enabled()
              ? await AppRuntime.runPromise(
                  ProviderAccountProfiles.Service.use((profiles) => profiles.list("openai", "chatgpt-oauth")),
                ).catch(() => {
                  throw new UtilityAccount.Failure("account-unavailable")
                })
              : [],
            accountID: args.account,
            legacy: args.legacyAuth ?? false,
            interactive: process.stdin.isTTY ?? false,
          })
        : undefined
      const auth = new Map<string, UtilityAccount.Identity>()
      for (const item of models) {
        if (item.providerID !== "openai") continue
        auth.set(
          `${item.providerID}/${item.modelID}`,
          await AppRuntime.runPromise(
            UtilityAccount.resolve({
              operation: "roll-call",
              model: { providerID: item.providerID, id: item.modelID },
              ...(probeContext(item.providerID, context) && { context: probeContext(item.providerID, context) }),
            }),
          ).catch((err) => {
            if (err instanceof UtilityAccount.Failure) throw err
            throw new UtilityAccount.Failure("account-unavailable")
          }),
        )
      }

      if (!args.quiet && !structured) {
        UI.println(`${color(UI.Style.TEXT_INFO)}Prompting ${models.length} models...${color(UI.Style.TEXT_NORMAL)}`)
      }

      const results: Result[] = []
      const queue = [...models]
      const active: Promise<void>[] = []

      const run = async (item: (typeof models)[0]) => {
        const name = `${item.providerID}/${item.modelID}`
        const start = Date.now()
        const result = await call(item.model, args.prompt, args.timeout, start, auth.get(name))

        results.push({ model: name, ...result })

        if (!args.verbose || args.quiet || structured) return
        if (result.access) {
          UI.println(`${color(UI.Style.TEXT_SUCCESS)}✔${color(UI.Style.TEXT_NORMAL)} ${name} - ${result.latency}ms`)
          return
        }
        UI.println(
          `${color(UI.Style.TEXT_DANGER)}✘${color(UI.Style.TEXT_NORMAL)} ${name} - ${result.errorType}: ${result.errorMessage}`,
        )
      }

      while (queue.length > 0 || active.length > 0) {
        while (queue.length > 0 && active.length < args.parallel) {
          const item = queue.shift()
          if (!item) continue
          const promise = run(item).finally(() => {
            const index = active.indexOf(promise)
            if (index > -1) active.splice(index, 1)
          })
          active.push(promise)
        }
        if (active.length > 0) await Promise.race(active)
      }

      if (json) {
        console.log(JSON.stringify(results, null, 2))
        return
      }

      const rows = results.map((result) => [
        result.model,
        result.access ? "YES" : "NO",
        result.access ? result.snippet : result.errorMessage ? `(${result.errorMessage})` : "",
        result.latency !== null ? `${result.latency}ms` : "N/A",
      ])

      if (args.output === "md") {
        console.log(formatMarkdown(rows))
        return
      }

      const width = parseInt(process.env.COLUMNS || "", 10) || process.stdout.columns || 80
      const table = formatTable(rows, width)

      UI.println(table.header)
      UI.println(table.separator)
      table.rows.forEach((line, index) => {
        const style = results[index].access ? UI.Style.TEXT_SUCCESS : UI.Style.TEXT_DANGER
        UI.println(color(style) + line + color(UI.Style.TEXT_NORMAL))
      })

      if (args.quiet) return
      const successful = results.filter((result) => result.access).length
      const failed = results.length - successful
      UI.println("")
      UI.println(
        `${color(UI.Style.TEXT_SUCCESS)}${successful} accessible${color(UI.Style.TEXT_NORMAL)}, ${color(UI.Style.TEXT_DANGER)}${failed} failed${color(UI.Style.TEXT_NORMAL)}`,
      )
    },
  })
}

async function call(
  model: Provider.Model,
  prompt: string,
  timeout: number,
  start: number,
  authority?: UtilityAccount.Identity,
): Promise<Omit<Result, "model">> {
  try {
    const { AppRuntime, Provider, RuntimeFlags, UtilityAccount, generateText, opencodeSessionHeaders } = await deps()
    const auth =
      authority ??
      (model.providerID === "openai"
        ? await AppRuntime.runPromise(
            UtilityAccount.resolve({
              operation: "roll-call",
              model: { providerID: model.providerID, id: model.id },
            }),
          )
        : undefined)
    if (auth?.mode === "profile" && model.api.npm !== "@ai-sdk/openai")
      throw new UtilityAccount.Failure("context-mismatch")
    const language = auth
      ? await AppRuntime.runPromise(
          Provider.Service.use((svc) => svc.getLanguage(model, auth.mode === "profile" ? auth.profileID : undefined)),
        )
      : await lang(model)
    const sessionID = auth?.id ?? randomUUID()
    const options = ProviderTransform.options({ model, sessionID })
    const providerOptions = ProviderTransform.providerOptions(
      model,
      auth?.mode === "profile"
        ? { ...options, instructions: "Reply briefly to confirm model connectivity.", store: false }
        : options,
    )
    const maxOutputTokens = await AppRuntime.runPromise(
      RuntimeFlags.Service.useSync((flags) => outputLimit(model, flags.outputTokenMax)),
    )
    const temperature = ProviderTransform.temperature(model)
    const topP = ProviderTransform.topP(model)
    const topK = ProviderTransform.topK(model)
    const messages: Parameters<typeof generateText>[0]["messages"] = [{ role: "user", content: prompt }]
    const transformed = ProviderTransform.message(messages, model, options)
    const result = await generateText({
      model: language,
      messages: transformed,
      abortSignal: AbortSignal.timeout(timeout),
      maxOutputTokens,
      temperature,
      topP,
      topK,
      providerOptions,
      headers: opencodeSessionHeaders({ providerID: model.providerID, sessionID }),
    })

    return {
      access: true,
      snippet: result.text.replace(/\n/g, " "),
      latency: Date.now() - start,
      errorType: null,
      errorMessage: null,
    }
  } catch (cause) {
    const err = error(cause)
    return {
      access: false,
      snippet: "",
      latency: Date.now() - start,
      errorType: err.type === "timeout" || err.type === "api_error" ? err.type : "unknown",
      errorMessage: err.type === "timeout" ? "The operation timed out." : "The model request failed.",
    }
  }
}

function error(cause: unknown) {
  if (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.message.includes("abort") || cause.message.includes("timeout"))
  ) {
    return { type: "timeout", message: "The operation timed out." }
  }

  if (typeof cause === "object" && cause && "error" in cause) {
    const data = cause.error as { type?: unknown; message?: unknown }
    if (typeof data.type === "string" || typeof data.message === "string") {
      return {
        type: typeof data.type === "string" ? data.type : "api_error",
        message: typeof data.message === "string" ? data.message : cause instanceof Error ? cause.message : "API error",
      }
    }
  }

  if (cause instanceof Error) return { type: "unknown", message: cause.message }
  return { type: "unknown", message: "An unknown error occurred" }
}

type ArgumentsCamelCase = {
  prompt: string
  timeout: number
  filter: string
  parallel: number
  output: "table" | "json" | "md"
  verbose: boolean
  quiet: boolean
  list?: typeof list
  account?: string
  legacyAuth?: boolean
}
