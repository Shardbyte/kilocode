import path from "node:path"
import { Effect, Layer } from "effect"

const [mode, root, home, sid, profile, account] = process.argv.slice(2)
if (!mode || !root || !home) throw new Error("Lifecycle process arguments are required")
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_STATE_HOME = path.join(home, "state")
process.env.KILO_DB = path.join(root, "binding-process.sqlite")
process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES = "1"
process.env.KILO_EXPERIMENTAL_EVENT_SYSTEM = "true"
process.env.KILO_EXPERIMENTAL_WORKSPACES = "true"
process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"

const { Server } = await import("@/server/server")
const { ServerAuth } = await import("@/server/auth")
const { ProviderAccountProfiles } = await import("@opencode-ai/core/kilocode/provider-account-profiles")
const { SessionBinding } = await import("@opencode-ai/core/kilocode/session-binding")
const { Database } = await import("@opencode-ai/core/database/database")
const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
const { AppRuntime } = await import("@/effect/app-runtime")
const { createKiloClient } = await import("@kilocode/sdk/v2")
const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const sdk = createKiloClient({ baseUrl: `http://${server.hostname}:${server.port}`, headers: ServerAuth.headers() })
const line = (value: Record<string, unknown>) => console.log(`LIFECYCLE_PROCESS ${JSON.stringify(value)}`)
const command = (type: string) =>
  (async () => {
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const item = await reader.read()
      if (item.done) throw new Error(`process worker expected ${type} barrier`)
      buf += decoder.decode(item.value, { stream: true })
      const at = buf.indexOf("\n")
      if (at < 0) continue
      const value = JSON.parse(buf.slice(0, at)) as { type: string }
      if (value.type !== type) throw new Error(`process worker expected ${type} barrier`)
      return
    }
  })()

try {
  if (mode === "owner") {
    const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
    const a = await AppRuntime.runPromise(
      profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "process-A",
        remoteID: "process-A",
        credential: {
          access: "PROCESS_ACCESS_A",
          refresh: "PROCESS_REFRESH_A",
          expires: Date.now() + 60_000,
          accountID: "process-A",
        },
      }),
    )
    const b = await AppRuntime.runPromise(
      profiles.create({
        provider: "openai",
        authMode: "chatgpt-oauth",
        label: "process-B",
        remoteID: "process-B",
        credential: {
          access: "PROCESS_ACCESS_B",
          refresh: "PROCESS_REFRESH_B",
          expires: Date.now() + 60_000,
          accountID: "process-B",
        },
      }),
    )
    await AppRuntime.runPromise(profiles.clearDefault("openai", "chatgpt-oauth"))
    const created = await sdk.session.create({ directory: process.cwd(), title: "cross-process admission" })
    if (!created.data) throw new Error("session creation failed")
    const assigned = await sdk.providerAccounts.session.assign({
      sessionID: created.data.id,
      providerID: "openai",
      accountID: a.id,
      directory: process.cwd(),
    })
    if (!assigned.data) throw new Error(`initial assignment failed: ${JSON.stringify(assigned.error)}`)
    await AppRuntime.runPromise(profiles.remove(a.id))
    const fresh = await sdk.session.create({ directory: process.cwd(), title: "cross-process new assignment" })
    if (!fresh.data) throw new Error("new session creation failed")
    const barrier = command("release")
    const ready = Promise.withResolvers<void>()
    let count = 0
    const db = await AppRuntime.runPromise(Database.Service)
    const layer = LayerNode.compile(LayerNode.group([SessionBinding.node, Database.node]), [
      [Database.node, Layer.succeed(Database.Service, db)],
    ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* SessionBinding.Service
        const hold = (sessionID: string) =>
          lock.turn(
            sessionID,
            Effect.promise(async () => {
              count++
              if (count === 2) {
                line({
                  event: "turn-held",
                  pid: process.pid,
                  sessionID: created.data!.id,
                  freshID: fresh.data!.id,
                  profileID: a.id,
                  otherID: b.id,
                })
                ready.resolve()
              }
              await barrier
            }),
          )
        yield* Effect.all([hold(created.data.id), hold(fresh.data.id)], { concurrency: 2 })
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    line({ event: "owner-released" })
  } else if (mode === "contender") {
    if (!sid || !profile || !account) throw new Error("contender session/profile/account IDs are required")
    const profiles = await AppRuntime.runPromise(ProviderAccountProfiles.Service)
    const exists = await AppRuntime.runPromise(profiles.get(account))
    const assignment = await sdk.providerAccounts.session.assign({
      sessionID: profile,
      providerID: "openai",
      accountID: account,
      directory: process.cwd(),
    })
    const repair = await sdk.providerAccounts.session.assign({
      sessionID: sid,
      providerID: "openai",
      accountID: account,
      confirmRepair: true,
      directory: process.cwd(),
    })
    line({
      event: "admissions",
      pid: process.pid,
      profileExists: Boolean(exists),
      assignment: { status: assignment.response?.status, error: assignment.error },
      repair: { status: repair.response?.status, error: repair.error },
    })
  } else throw new Error(`unknown worker mode: ${mode}`)
} finally {
  await server.stop(true)
}
await AppRuntime.dispose()
process.exit(0)
