// kilocode_change - correlate OAuth completions with the exact profile operation
export type OAuthStart = {
  operationID: string
  url: string
  instructions: string
}

export type OAuthAdapter<T> = {
  start: () => Promise<OAuthStart>
  complete: (operationID: string) => Promise<T>
  cancel?: (operationID: string) => Promise<void>
}

export type OAuthFlow<T, C> = {
  start: (context: C) => Promise<OAuthStart>
  complete: (operationID: string) => Promise<{ context: C; result: T }>
  cancel: (operationID: string) => Promise<void>
  purge: () => Promise<void>
}

const TTL = 10 * 60 * 1000
const LIMIT = 32

export class OAuthOperationUnavailableError extends Error {
  constructor() {
    super("Provider OAuth operation is unavailable")
  }
}

export function makeOAuthFlow<T, C>(adapter: OAuthAdapter<T>, now = () => Date.now()): OAuthFlow<T, C> {
  const pending = new Map<string, { context: C; started: number }>()

  const purge = async () => {
    for (const [id, item] of pending) {
      if (now() - item.started <= TTL) continue
      pending.delete(id)
      await adapter.cancel?.(id)
    }
  }

  return {
    start: async (context) => {
      await purge()
      if (pending.size >= LIMIT) throw new Error("Too many active provider OAuth operations")
      const result = await adapter.start()
      if (pending.has(result.operationID)) throw new Error("Provider OAuth adapter reused an active operation ID")
      pending.set(result.operationID, { context, started: now() })
      return result
    },
    complete: async (operationID) => {
      const item = pending.get(operationID)
      if (!item) throw new OAuthOperationUnavailableError()
      if (now() - item.started > TTL) {
        pending.delete(operationID)
        await adapter.cancel?.(operationID)
        throw new OAuthOperationUnavailableError()
      }
      pending.delete(operationID)
      try {
        const result = await adapter.complete(operationID)
        return { context: item.context, result }
      } catch (error) {
        await adapter.cancel?.(operationID)
        throw error
      }
    },
    cancel: async (operationID) => {
      if (!pending.has(operationID)) throw new OAuthOperationUnavailableError()
      pending.delete(operationID)
      await adapter.cancel?.(operationID)
    },
    purge,
  }
}
