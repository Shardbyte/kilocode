import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"

type Event = { type: string; pid?: number; entered?: boolean; error?: string; operation?: string }

function launch(db: string, mode: "turn" | "exclusive", sid: string, operation?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../fixture/kilocode-provider-profile-admission-worker.ts"),
      db,
      mode,
      sid,
      operation ?? "",
    ],
    { cwd: path.resolve(import.meta.dir, "../.."), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const next = async (): Promise<Event> => {
    while (!buf.includes("\n")) {
      const item = await reader.read()
      if (item.done)
        throw new Error(`Admission worker exited (${await child.exited}): ${await new Response(child.stderr).text()}`)
      buf += decoder.decode(item.value, { stream: true })
    }
    const at = buf.indexOf("\n")
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    return JSON.parse(line) as Event
  }
  const send = (type: string) => child.stdin.write(`${JSON.stringify({ type })}\n`)
  return { child, next, send }
}

test("independent SQLite processes deny assignment and repair admission during a live same-session turn", async () => {
  await using tmp = await tmpdir()
  const db = path.join(tmp.path, "provider-profile-admission.db")
  const sid = "ses_admission_cross_process"
  const owner = launch(db, "turn", sid)
  const workers: ReturnType<typeof launch>[] = [owner]
  try {
    const held = await owner.next()
    expect(held.type).toBe("turn-held")

    for (const operation of ["assignment", "repair"]) {
      const contender = launch(db, "exclusive", sid, operation)
      workers.push(contender)
      const denied = await contender.next()
      expect(denied.type).toBe("exclusive-denied")
      expect(denied.operation).toBe(operation)
      expect(denied.entered).toBe(false)
      expect(denied.error).toContain("SessionBinding.TurnActiveError")
      expect(await contender.child.exited).toBe(0)
    }

    const other = launch(db, "exclusive", "ses_other_admission")
    workers.push(other)
    expect((await other.next()).type).toBe("exclusive-entered")
    await other.send("release-exclusive")
    expect((await other.next()).type).toBe("exclusive-released")
    expect(await other.child.exited).toBe(0)

    await owner.send("release-turn")
    expect((await owner.next()).type).toBe("turn-released")
    expect(await owner.child.exited).toBe(0)

    const after = launch(db, "exclusive", sid)
    workers.push(after)
    expect((await after.next()).type).toBe("exclusive-entered")
    await after.send("release-exclusive")
    expect((await after.next()).type).toBe("exclusive-released")
    expect(await after.child.exited).toBe(0)

    const exclusive = launch(db, "exclusive", sid, "assignment")
    workers.push(exclusive)
    expect((await exclusive.next()).type).toBe("exclusive-entered")
    const repair = launch(db, "exclusive", sid, "repair")
    workers.push(repair)
    expect(await repair.next()).toMatchObject({ type: "exclusive-denied", operation: "repair", entered: false })
    expect(await repair.child.exited).toBe(0)
    await exclusive.send("release-exclusive")
    expect((await exclusive.next()).type).toBe("exclusive-released")
    expect(await exclusive.child.exited).toBe(0)

    expect(await Promise.all(workers.map((worker) => new Response(worker.child.stderr).text()))).toEqual(
      workers.map(() => ""),
    )
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill(9)
    await Promise.all(workers.map((worker) => worker.child.exited))
  }
}, 30_000)
