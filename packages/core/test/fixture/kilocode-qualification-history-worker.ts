import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [root, mode, file, dir, text] = process.argv.slice(2)
assert(root && mode && file && dir && text)
assert(mode === "produce" || mode === "read")

const load = (name: string) => import(pathToFileURL(path.join(root, "src", name)).href)
const [{ Effect, Layer }, { Database }, { LayerNode }, profilesMod] = await Promise.all([
  import(pathToFileURL(path.join(root, "node_modules/effect/dist/index.js")).href),
  load("database/database.ts"),
  load("effect/layer-node.ts"),
  load("kilocode/provider-account-profiles.ts"),
])
const { sql } = await import(pathToFileURL(path.join(root, "node_modules/drizzle-orm/index.js")).href)
const [{ ProjectTable }, { SessionTable }] = await Promise.all([load("project/sql.ts"), load("session/sql.ts")])
const bind = await load("kilocode/session-binding.ts").catch(() => undefined)
const profiles = profilesMod.ProviderAccountProfiles
const layer = LayerNode.compile(LayerNode.group([profiles.node, Database.Database.node]), [
  [Database.Database.node, Database.Database.layerFromPath(file).pipe(Layer.fresh)],
])
const state = text === "-" ? undefined : JSON.parse(text) as State
await Effect.runPromise(Effect.gen(function* () {
  const svc = yield* profiles.Service
  const { db } = yield* Database.Database.Service
  if (mode === "produce") {
    const acct = yield* svc.create({
      provider: "openai",
      authMode: "chatgpt-oauth",
      label: "Qualification account",
      remoteID: "qualification-remote",
      credential: secret("initial"),
    })
    const revision = yield* svc.compareAndSwapCredential({
      id: acct.id,
      revision: 0,
      value: secret("rotated"),
    })
    assert.equal(revision, 1)
    yield* svc.selectDefault("openai", "chatgpt-oauth", acct.id)
    assert.equal(yield* svc.getDefault("openai", "chatgpt-oauth"), acct.id)
    assert.deepEqual(yield* svc.credential(acct.id), { value: secret("rotated"), revision: 1 })

    if (bind) {
      const now = Date.now()
      const proj = "prj_qualification"
      const ses = "ses_qualification"
      yield* db.insert(ProjectTable).values({
        id: proj,
        worktree: dir,
        sandboxes: [],
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run()
      const metadata = bind.SessionBinding.set(undefined, {
        version: 1,
        providers: {
          openai: { mode: "profile", profileID: acct.id, authMode: "chatgpt-oauth", source: "explicit" },
        },
      })
      yield* db.insert(SessionTable).values({
        id: ses,
        project_id: proj,
        slug: "qualification",
        directory: dir,
        title: "Qualification",
        version: "1",
        metadata,
        time_created: now,
        time_updated: now,
      }).onConflictDoNothing().run()
    }

    console.log(JSON.stringify({
      id: acct.id,
      revision,
      defaultMatches: true,
      credentialMatches: true,
      bindingSupported: !!bind,
      bindingMatches: !!bind,
      sessionID: "ses_qualification",
    }))
    return
  }

  assert(state)
  const rows = (yield* svc.list("openai", "chatgpt-oauth")) as { id: string }[]
  const credential = yield* svc.credential(state.id)
  const defaultID = yield* svc.getDefault("openai", "chatgpt-oauth")
  const session = bind
    ? yield* db.select({ metadata: SessionTable.metadata }).from(SessionTable).where(sql`${SessionTable.id} = ${state.sessionID}`).get()
    : undefined
  const info = bind && session?.metadata ? bind.SessionBinding.get(session.metadata) : undefined
  const bindingMatches = info?.providers.openai?.mode === "profile" && info.providers.openai.profileID === state.id
  const expectedBinding = !!bind && state.bindingSupported
  assert(rows.some((row) => row.id === state.id), "profile did not survive the source transition")
  assert.equal(credential?.revision, 1, "credential revision did not survive the source transition")
  assert.deepEqual(credential?.value, secret("rotated"), "rotated synthetic credential did not survive the source transition")
  assert.equal(defaultID, state.id, "default profile did not survive the source transition")
  assert.equal(bindingMatches, expectedBinding, "session binding did not survive the source transition")
  assert(rows.every((row) => !JSON.stringify(row).includes("SYNTHETIC_")), "credential leaked through profile info")
  console.log(JSON.stringify({
    profileFound: true,
    revision: credential.revision,
    credentialMatches: true,
    defaultMatches: true,
    bindingSupported: !!bind,
    bindingMatches,
    credentialRedacted: true,
  }))
}).pipe(Effect.provide(layer), Effect.scoped))

function secret(which: "initial" | "rotated") {
  return {
    access: `SYNTHETIC_${which.toUpperCase()}_ACCESS`,
    refresh: `SYNTHETIC_${which.toUpperCase()}_REFRESH`,
    expires: which === "initial" ? 1_900_000_000_000 : 1_900_000_000_001,
    accountID: "qualification-remote",
  }
}

type State = {
  id: string
  revision: number
  bindingSupported: boolean
  sessionID: string
}
