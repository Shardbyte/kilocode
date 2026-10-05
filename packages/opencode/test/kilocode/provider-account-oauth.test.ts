import { describe, expect, test } from "bun:test"
import { makeOAuthFlow } from "../../src/kilocode/provider-account-oauth"

describe("provider account OAuth operations", () => {
  test("completes concurrent operations in reverse order without crossing targets", async () => {
    const waits = new Map<string, ReturnType<typeof Promise.withResolvers<{ remoteID: string }>>>()
    const start = { value: 0 }
    const flow = makeOAuthFlow({
      start: async () => {
        start.value += 1
        const operationID = `op-${start.value}`
        waits.set(operationID, Promise.withResolvers<{ remoteID: string }>())
        return { operationID, url: `https://auth.invalid/${operationID}`, instructions: "Continue in browser" }
      },
      complete: async (operationID) => waits.get(operationID)!.promise,
    })

    const [first, second] = await Promise.all([
      flow.start({ target: "profile-a" }),
      flow.start({ target: "profile-b" }),
    ])
    const completeFirst = flow.complete(first.operationID)
    const completeSecond = flow.complete(second.operationID)
    waits.get(second.operationID)!.resolve({ remoteID: "remote-b" })
    waits.get(first.operationID)!.resolve({ remoteID: "remote-a" })

    expect(await completeSecond).toEqual({ context: { target: "profile-b" }, result: { remoteID: "remote-b" } })
    expect(await completeFirst).toEqual({ context: { target: "profile-a" }, result: { remoteID: "remote-a" } })
  })

  test("consumes an operation once and cancels it after completion failure", async () => {
    const canceled: string[] = []
    const flow = makeOAuthFlow({
      start: async () => ({ operationID: "op-a", url: "https://auth.invalid", instructions: "" }),
      complete: async () => Promise.reject(new Error("synthetic failure")),
      cancel: async (id) => void canceled.push(id),
    })
    await flow.start({ target: "profile-a" })

    await expect(flow.complete("op-a")).rejects.toThrow("synthetic failure")
    await expect(flow.complete("op-a")).rejects.toThrow("unavailable")
    expect(canceled).toEqual(["op-a"])
  })

  test("does not forward unknown operation IDs to the shared adapter", async () => {
    const calls: string[] = []
    const flow = makeOAuthFlow({
      start: async () => ({ operationID: "owned", url: "https://auth.invalid", instructions: "" }),
      complete: async (id: string) => {
        calls.push(`complete:${id}`)
        return { remoteID: "remote" }
      },
      cancel: async (id: string) => void calls.push(`cancel:${id}`),
    })

    await expect(flow.complete("foreign")).rejects.toThrow("unavailable")
    await expect(flow.cancel("foreign")).rejects.toThrow("unavailable")
    expect(calls).toEqual([])
  })

  test("completion claims the operation before awaiting and wins cancel races", async () => {
    const deferred = Promise.withResolvers<{ remoteID: string }>()
    const canceled: string[] = []
    const flow = makeOAuthFlow({
      start: async () => ({ operationID: "op-race", url: "https://auth.invalid", instructions: "" }),
      complete: async () => deferred.promise,
      cancel: async (id: string) => void canceled.push(id),
    })
    await flow.start({ target: "profile-a" })

    const claimed = flow.complete("op-race")
    await expect(flow.complete("op-race")).rejects.toThrow("unavailable")
    await expect(flow.cancel("op-race")).rejects.toThrow("unavailable")
    expect(canceled).toEqual([])
    deferred.resolve({ remoteID: "remote-a" })
    expect(await claimed).toEqual({ context: { target: "profile-a" }, result: { remoteID: "remote-a" } })
  })

  test("rejects an adapter operation ID collision without replacing the first context", async () => {
    const canceled: string[] = []
    const flow = makeOAuthFlow({
      start: async () => ({ operationID: "same", url: "https://auth.invalid", instructions: "" }),
      complete: async () => ({ remoteID: "remote" }),
      cancel: async (id: string) => void canceled.push(id),
    })
    await flow.start({ target: "first" })
    await expect(flow.start({ target: "second" })).rejects.toThrow("reused")
    expect(await flow.complete("same")).toEqual({ context: { target: "first" }, result: { remoteID: "remote" } })
    expect(canceled).toEqual([])
  })
})
