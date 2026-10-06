import { Cause, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionBinding } from "@opencode-ai/core/kilocode/session-binding"

const [file, mode, sid, operation] = process.argv.slice(2)
if (!file || (mode !== "turn" && mode !== "exclusive") || !sid) throw new Error("Invalid admission worker arguments")

const layer = LayerNode.compile(LayerNode.group([SessionBinding.node, Database.node]), [
  [Database.node, Database.layerFromPath(file).pipe(Layer.fresh)],
])

const input = (async function* () {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const item = await reader.read()
    if (item.done) return
    buf += decoder.decode(item.value, { stream: true })
    while (buf.includes("\n")) {
      const at = buf.indexOf("\n")
      yield JSON.parse(buf.slice(0, at)) as { type: string }
      buf = buf.slice(at + 1)
    }
  }
})()

const command = async (type: string) => {
  const item = await input.next()
  if (item.done || item.value.type !== type) throw new Error(`Expected ${type} barrier command`)
}

const send = (value: Record<string, unknown>) => console.log(JSON.stringify(value))

await Effect.runPromise(
  Effect.gen(function* () {
    const lock = yield* SessionBinding.Service
    if (mode === "turn") {
      yield* lock.turn(
        sid,
        Effect.promise(async () => {
          send({ type: "turn-held", pid: process.pid })
          await command("release-turn")
        }),
      )
      send({ type: "turn-released" })
      return
    }

    let entered = false
    const exit = yield* Effect.exit(
      lock.exclusive(
        sid,
        Effect.promise(async () => {
          entered = true
          send({ type: "exclusive-entered", operation, pid: process.pid })
          await command("release-exclusive")
        }),
      ),
    )
    send({
      type: exit._tag === "Success" ? "exclusive-released" : "exclusive-denied",
      operation,
      entered,
      error: exit._tag === "Failure" ? Cause.prettyErrors(exit.cause).join("\n") : undefined,
    })
  }).pipe(Effect.provide(layer), Effect.scoped),
)

process.exit(0)
