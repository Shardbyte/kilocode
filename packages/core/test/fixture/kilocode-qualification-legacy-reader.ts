import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [root, file, dir] = process.argv.slice(2)
assert(root && file && dir)
delete process.env.KILO_AUTH_CONTENT

const load = (name: string) => import(pathToFileURL(path.join(root, "src", name)).href)
const [{ Effect, Layer }, { Database }, { LayerNode }, { Credential }, { Integration }, { Global }] = await Promise.all([
  import(pathToFileURL(path.join(root, "node_modules/effect/dist/index.js")).href),
  load("database/database.ts"),
  load("effect/layer-node.ts"),
  load("credential.ts"),
  load("integration.ts"),
  load("global.ts"),
])
const layer = LayerNode.compile(Credential.node, [
  [Database.node, Database.layerFromPath(file).pipe(Layer.fresh)],
  [Global.node, Global.layerWith({ data: dir })],
]).pipe(Layer.fresh)
const result = await Effect.runPromise(Effect.gen(function* () {
  const credential = yield* Credential.Service
  const rows = yield* credential.list(Integration.ID.make("openai"))
  const value = rows.at(-1)?.value
  assert.equal(rows.length, 1)
  assert.equal(value?.type, "oauth")
  assert.equal(value?.access, "SYNTHETIC_STALE_AUTH_ACCESS")
  assert.equal(value?.refresh, "SYNTHETIC_STALE_AUTH_REFRESH")
  assert.equal(value?.methodID, Integration.MethodID.make("chatgpt-browser"))
  return { rowCount: rows.length, staleAuthObserved: true, method: "chatgpt-browser" }
}).pipe(Effect.provide(layer), Effect.scoped))
console.log(JSON.stringify(result))
