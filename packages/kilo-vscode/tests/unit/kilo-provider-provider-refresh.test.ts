import { describe, expect, it, spyOn } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

type Internals = {
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  handleProviderAccounts: (message: Record<string, unknown>) => Promise<void>
  providersRetry: boolean
  cachedConfigMessage: unknown
  cachedConfigDirectory: string | null
  retryInitialization: () => Promise<void>
  refreshConfig: (type: "configLoaded" | "configUpdated", dir?: string) => Promise<void>
  initializeConnection: () => Promise<void>
  fetchAndSendProviders: () => Promise<void>
  fetchAndSendIndexingStatus: (directory?: string, projectId?: string) => void
  flushPendingKiloModel: () => void
  checkConfigWarnings: (reason: string) => Promise<void>
  syncWebviewState: (reason: string) => Promise<void>
  flushPendingSessionRefresh: (reason: string) => Promise<void>
  recoverPendingPrompts: () => void
  fetchAndSendAgents: () => Promise<void>
  fetchAndSendSkills: () => Promise<void>
  fetchAndSendCommands: () => Promise<void>
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendNotifications: () => Promise<void>
  seedSessionStatusMap: () => Promise<void>
  sendNotificationSettings: () => void
  startStatsPolling: () => void
}

function connection(online = true, custom?: unknown) {
  let listener: ((state: State, error?: Error) => void) | undefined
  const client = custom ?? { kilo: { profile: async () => ({ data: null }) } }
  return {
    emitState(next: State) {
      if (!listener) throw new Error("expected a connection state subscription")
      listener(next)
    },
    connect: async () => {},
    getClient: () => {
      if (!online) throw new Error("Not connected — call connect() first")
      return client as never
    },
    onEventFiltered: () => () => undefined,
    onStateChange: (next: typeof listener) => {
      listener = next
      return () => undefined
    },
    onNotificationDismissed: () => () => undefined,
    onClearPendingPrompts: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    unregisterVisible: () => undefined,
    unregisterAttached: () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
  }
}

function provider(service: ReturnType<typeof connection>, root = () => "/repo") {
  return new KiloProvider({} as never, service as never, undefined, {
    rootDirectory: root,
  }) as unknown as Internals
}

function stub(internal: Internals) {
  internal.webview = { postMessage: async () => true }
  internal.fetchAndSendIndexingStatus = () => {}
  internal.flushPendingKiloModel = () => {}
  internal.checkConfigWarnings = async () => {}
  internal.syncWebviewState = async () => {}
  internal.flushPendingSessionRefresh = async () => {}
  internal.recoverPendingPrompts = () => {}
  internal.fetchAndSendAgents = async () => {}
  internal.fetchAndSendSkills = async () => {}
  internal.fetchAndSendCommands = async () => {}
  internal.fetchAndSendConfig = async () => {}
  internal.fetchAndSendNotifications = async () => {}
  internal.seedSessionStatusMap = async () => {}
  internal.sendNotificationSettings = () => {}
  internal.startStatsPolling = () => {}
}

describe("KiloProvider providers on reconnect", () => {
  it("recovers providers against the selected project without reconnecting", async () => {
    let dir = "/unavailable"
    const requests: string[] = []
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
        provider: {
          list: async (input: { directory: string }) => {
            requests.push(input.directory)
            if (input.directory === "/unavailable") throw new Error("PermissionDenied")
            return { data: { all: [], connected: [], default: {} } }
          },
        },
      }),
      () => dir,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }
    const configs: string[] = []
    internal.fetchAndSendConfig = async () => {
      configs.push(dir)
      internal.cachedConfigMessage = { type: "configLoaded", config: {} }
      internal.cachedConfigDirectory = dir
    }
    await internal.fetchAndSendProviders()
    expect(internal.providersRetry).toBe(true)

    dir = "/healthy"
    await internal.retryInitialization()

    expect(requests).toEqual(["/unavailable", "/healthy"])
    expect(configs).toEqual(["/healthy"])
    expect(internal.providersRetry).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({ type: "providersLoaded", ready: true }))

    await internal.retryInitialization()
    expect(requests).toHaveLength(2)
    expect(configs).toHaveLength(1)
  })

  it("drops a config snapshot that resolves for a previous project directory", async () => {
    let dir = "/project-a"
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        config: {
          get: async () => ({ data: {} }),
          overlay: async () => ({ data: { collections: [] } }),
        },
        global: { config: { get: async () => ({ data: {} }) } },
        experimental: { capabilities: { get: async () => ({ data: { backgroundSubagents: false } }) } },
      }),
      () => dir,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }

    await internal.refreshConfig("configLoaded", "/project-a")
    expect(messages).toContainEqual(expect.objectContaining({ type: "configLoaded" }))
    const published = messages.length

    dir = "/project-b"
    await internal.refreshConfig("configLoaded", "/project-a")

    expect(messages).toHaveLength(published)
  })

  it("marks a retry when providers are fetched without a client", async () => {
    const internal = provider(connection(false))
    stub(internal)

    await internal.fetchAndSendProviders()

    expect(internal.providersRetry).toBe(true)
  })

  it("marks a retry when the provider fetch rejects with a client", async () => {
    const reject = {
      kilo: { authStatus: async () => ({ data: undefined }) },
      provider: {
        list: async () => {
          throw new Error("backend gone")
        },
      },
    }
    const internal = provider(connection(true, reject))
    stub(internal)

    await internal.fetchAndSendProviders()

    expect(internal.providersRetry).toBe(true)
  })

  it("fetches providers on connect when a previous fetch had no client", async () => {
    const service = connection()
    const internal = provider(service)
    let providers = 0
    stub(internal)
    internal.fetchAndSendProviders = async () => {
      providers++
    }
    await internal.initializeConnection()
    internal.providersRetry = true
    const before = providers

    service.emitState("connected")
    await Bun.sleep(0)

    expect(providers).toBe(before + 1)
  })

  it("does not refetch providers on connect when none are pending", async () => {
    const service = connection()
    const internal = provider(service)
    let providers = 0
    stub(internal)
    internal.fetchAndSendProviders = async () => {
      providers++
    }
    await internal.initializeConnection()
    const before = providers

    service.emitState("connected")
    await Bun.sleep(0)

    expect(providers).toBe(before)
  })
})

describe("Provider Account availability refresh", () => {
  it("refreshes authoritative providers after account mutations but not metadata changes", async () => {
    const vscode = await import("vscode")
    const browser = spyOn(vscode.env, "openExternal").mockResolvedValue(true)
    const confirm = spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Continue" as never)
    let connected = false
    const posts: unknown[] = []
    const operation = { operationID: "op", url: "https://auth.openai.com/oauth/authorize" }
    const client = {
      kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
      provider: {
        list: async () => ({
          data: {
            all: [
              { id: "openai", name: "OpenAI", source: "profile", models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } } },
            ],
            connected: connected ? ["openai"] : [],
            default: {},
          },
        }),
      },
      providerAccounts: {
        list: async () => ({ data: { accounts: [] } }),
        oauth: {
          start: async () => ({ data: operation }),
          reauthenticate: async () => ({ data: operation }),
          complete: async () => {
            connected = true
            return {}
          },
          cancel: async () => ({}),
        },
        remove: async () => {
          connected = false
          return {}
        },
        rename: async () => ({}),
        default: { select: async () => ({}) },
      },
    }
    const internal = provider(connection(true, client))
    stub(internal)
    internal.webview = { postMessage: async (message) => posts.push(message) }
    try {
      await internal.fetchAndSendProviders()
      expect(posts.at(-1)).toMatchObject({ type: "providersLoaded", connected: [] })
      for (const action of ["add", "reauth", "remove"]) {
        await internal.handleProviderAccounts({ action, label: "Account", id: "account", revision: 0 })
        expect(posts).toContainEqual(expect.objectContaining({ type: "providersLoading" }))
        expect(posts.at(-1)).toMatchObject({
          type: "providersLoaded",
          connected: action === "remove" ? [] : ["openai"],
        })
      }
      const count = posts.filter((post) => (post as { type: string }).type === "providersLoaded").length
      for (const action of ["rename", "default"]) {
        await internal.handleProviderAccounts({ action, label: "Renamed", id: "account" })
      }
      expect(posts.filter((post) => (post as { type: string }).type === "providersLoaded")).toHaveLength(count)
    } finally {
      browser.mockRestore()
      confirm.mockRestore()
    }
  })
})
