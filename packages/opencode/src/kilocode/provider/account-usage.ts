import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ProviderAccountProfiles } from "@opencode-ai/core/kilocode/provider-account-profiles"
import { ProviderUsage } from "@opencode-ai/core/kilocode/provider-usage"
import * as Codex from "@opencode-ai/core/kilocode/provider-usage/codex"
import { refresh } from "@/kilocode/provider/codex-profile"

const successTtl = 60_000
const errorTtl = 10_000

export interface AccountUsage {
  accountID: string
  providerID: "openai"
  authMode: "chatgpt-oauth"
  retrievedAt: string
  generation: number
  snapshot: ProviderUsage.Schema.UsageSnapshot
}

export interface Interface {
  readonly get: (id: string, force?: boolean) => Effect.Effect<AccountUsage>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/ProviderAccountUsage") {}

interface Cell {
  revision: number
  expires: number
  generation: number
  value?: AccountUsage
  inflight?: Promise<AccountUsage>
}

function unavailable(id: string, auth = false): ProviderUsage.Schema.UsageSnapshot {
  return {
    id: `codex-chatgpt:${id}`,
    providerID: "openai",
    sourceKind: "direct",
    providerLabel: "OpenAI",
    planLabel: "ChatGPT Codex",
    sourceLabel: "ChatGPT OAuth",
    fetchState: "unavailable",
    planState: "unknown",
    routingState: "not_applicable",
    managementUrl: "https://chatgpt.com/codex/settings/usage",
    windows: [],
    error: {
      code: auth ? "codex_auth_unavailable" : "codex_usage_unavailable",
      message: auth ? "Reconnect ChatGPT to view Codex usage." : "Usage unavailable.",
      retryable: !auth,
    },
  }
}

function result(id: string, generation: number, snapshot: ProviderUsage.Schema.UsageSnapshot): AccountUsage {
  return {
    accountID: id,
    providerID: "openai",
    authMode: "chatgpt-oauth",
    retrievedAt: new Date().toISOString(),
    generation,
    snapshot,
  }
}

function makeService(profiles: ProviderAccountProfiles.Interface, transport: ProviderUsage.TransportInterface) {
  // Usage is intentionally process-local; restarting the service always retrieves fresh account usage.
  const cells = new Map<string, Cell>()
  const versions = new Map<string, number>()

  const invalidate = (id: string) => {
    cells.delete(id)
    const generation = (versions.get(id) ?? 0) + 1
    versions.set(id, generation)
    return result(id, generation, unavailable(id))
  }

  const live = async (id: string) => {
    const info = await Effect.runPromise(profiles.get(id))
    if (!info || info.provider !== "openai" || info.authMode !== "chatgpt-oauth") return undefined
    const credential = await Effect.runPromise(profiles.credential(id))
    if (!credential) return undefined
    return { info, credential }
  }

  const discard = () => {
    for (const id of cells.keys()) {
      versions.set(id, (versions.get(id) ?? 0) + 1)
      cells.delete(id)
    }
  }

  const unavailableIfDisabled = (id: string) => {
    if (ProviderAccountProfiles.enabled()) return undefined
    discard()
    return result(id, versions.get(id) ?? 0, unavailable(id))
  }

  const get = async (id: string, force = false): Promise<AccountUsage> => {
    const disabled = unavailableIfDisabled(id)
    if (disabled) return disabled
    if (!(await live(id).catch(() => undefined))) return invalidate(id)

    try {
      await refresh(id, profiles, transport.fetch)
    } catch {
      return invalidate(id)
    }
    const current = await live(id).catch(() => undefined)
    const afterRefresh = unavailableIfDisabled(id)
    if (afterRefresh || !current) return afterRefresh ?? invalidate(id)
    const revision = current.credential.revision
    const prior = cells.get(id)
    if (prior?.revision === revision && prior.inflight) return prior.inflight
    if (!force && prior?.revision === revision && prior.value && prior.expires > Date.now()) {
      const verify = await live(id).catch(() => undefined)
      const beforeReturn = unavailableIfDisabled(id)
      if (beforeReturn) return beforeReturn
      if (!verify || verify.credential.revision !== revision) return invalidate(id)
      if (cells.get(id) !== prior || versions.get(id) !== prior.generation)
        return result(id, prior.generation, unavailable(id))
      return prior.value
    }

    const generation = (versions.get(id) ?? 0) + 1
    versions.set(id, generation)
    const cell: Cell = { revision, expires: 0, generation }
    cells.set(id, cell)
    const task = (async () => {
      let snapshot = unavailable(id)
      try {
        const handoff = await Effect.runPromise(
          profiles.dispatch(id, (auth, actual) => {
            if (actual !== revision) throw new Error("Provider account changed before usage dispatch")
            return Codex.query(
              { label: "OpenAI", access: auth.access, account: auth.accountID ?? current.info.remoteID ?? undefined },
              transport.fetch,
            )
          }),
        )
        const native = await handoff.response
        // Keep quota values without echoing arbitrary upstream names, IDs, or profile labels.
        snapshot = {
          ...Codex.normalize({
            ...native,
            additional: native.additional.map((item, index) => ({
              id: `quota-${index}`,
              name: `Additional quota ${index + 1}`,
              rate: item.rate,
            })),
          }),
          id: `codex-chatgpt:${id}`,
        }
      } catch (err) {
        const auth = err instanceof Error && "code" in err && err.code === "auth"
        snapshot = unavailable(id, auth)
      }
      const verify = await live(id).catch(() => undefined)
      const beforeApply = unavailableIfDisabled(id)
      if (
        beforeApply ||
        !verify ||
        verify.credential.revision !== revision ||
        versions.get(id) !== generation ||
        cells.get(id) !== cell
      ) {
        if (beforeApply) return beforeApply
        if (cells.get(id) === cell) return invalidate(id)
        return result(id, generation, unavailable(id))
      }
      const previous = prior?.revision === revision ? prior.value?.snapshot : undefined
      if (
        snapshot.fetchState === "unavailable" &&
        snapshot.error?.retryable &&
        previous &&
        (previous.fetchState === "ready" || previous.fetchState === "stale")
      ) {
        snapshot = {
          ...previous,
          id: `codex-chatgpt:${id}`,
          fetchState: "stale",
          error: snapshot.error,
        }
      }
      const value = result(id, generation, snapshot)
      cell.value = value
      cell.expires = Date.now() + (snapshot.fetchState === "ready" ? successTtl : errorTtl)
      return value
    })().finally(() => {
      if (cells.get(id) === cell) cell.inflight = undefined
    })
    cell.inflight = task
    return task
  }

  return Service.of({ get: (id, force) => Effect.promise(() => get(id, force)) })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return makeService(yield* ProviderAccountProfiles.Service, yield* ProviderUsage.Transport)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ProviderAccountProfiles.node, ProviderUsage.transportNode],
})
