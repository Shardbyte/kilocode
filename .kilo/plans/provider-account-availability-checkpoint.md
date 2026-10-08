# Provider Account availability correction

Implemented on `feat/provider-account-profiles`, starting at frozen snapshot `99915bc7b3d49782fc629fc6f6b7b39b6e2aef41`. No rebase, upstream update, inference/request-construction change, or account-card redesign is included. Validation uses Bun 1.4.2 and the frozen lockfile.

## Root cause and lifecycle trace

`Provider.Service` builds its model/provider state in a directory-keyed `InstanceState` cache. At the frozen snapshot it already merges OpenAI's bundled catalog when Provider Accounts exist, but only during cache construction. Opening the extension primes that cache before the first account is created. Account OAuth completion and removal did not invalidate it. The extension's account handler also refreshed only `providerAccountsLoaded`, leaving `cachedProvidersMessage` and the model list unchanged. Thus a healthy first account could coexist with a cached provider list that excluded OpenAI.

The `/provider` endpoint obtains `connected` from `Object.keys(provider.list())`, overlays connected models onto the bundled catalog, and emits that list to the extension. `fetchProviderData()` preserves non-Kilo provider availability; `fetchAndSendProviders()` caches and emits it as `providersLoaded.connected`. Both the model selector and selection-validity check consume that list.

Legacy auth set/removal already calls `invalidateAfterProviderAuthChange()`: clear the provider model cache, dispose all loaded directory instances, and emit `server.instance.disposed`. OAuth callbacks also dispose loaded instances. The extension subscribes to disposal events, clears its provider cache, and reloads config/agents/providers. The correction brings supported account OAuth completion/removal into the existing auth lifecycle. The initiating account handler additionally invalidates/refetches providers after successful add/remove/reauth so its panel does not depend on SSE arrival. Other panels retain the existing disposal-event refresh path.

Rename and default changes do not invalidate discovery. Usage-driven credential refresh does not change the connection source and needs no availability invalidation. Successful explicit reauthentication rebuilds state but retains the same eligible connection. Account removal invalidates all directory instances because account storage is global, whereas provider caches are directory-scoped.

## Exact semantics

`connected` retains its existing meaning: providers available through supported connection sources, rather than evidence of a stored legacy credential. Environment/config/plugin/API sources retain existing discovery rules and provider allow/deny/model filters. A separate availability array is unnecessary.

For the opt-in OpenAI/ChatGPT MVP, accounts make OpenAI available when a supported profile has a stored credential with an account identity matching any recorded remote identity, and either a current nonempty access token or a nonempty refresh token. An expired access token remains eligible when that exact account can refresh itself. Missing credentials/identity and expired unrefreshable credentials do not confer availability. This check reads metadata/credentials; it never refreshes, chooses a default, assigns a profile, or modifies a session.

Profile-only OpenAI uses the distinct public `source: "profile"`. Existing sources take precedence when they already make OpenAI available; profiles no longer overwrite an API/environment/config/plugin source with `custom`. The Providers row displays **Provider Accounts** for profile-only availability and has no legacy Disconnect button. Existing account management remains in the account panel. It does not claim a legacy/API credential or introduce the future nested account-card design.

The same shared availability predicate is now used by the selector and `isModelValid()`. The selector retains the frozen snapshot's lazy popup behavior and small-model filtering. SDK types/OpenAPI are regenerated, including generator-maintained compatibility for the retired legacy SDK's plugin Provider contract.

Credential authority remains the persisted session binding. Existing bound sessions keep their exact `profileID`, including after its deletion; availability does not repair them or move them to another available account. Default changes affect newly created sessions only. No API/env/legacy/profile fallback, rotation, automatic account selection, or session-authority mutation is added.

## Connected-row relationship

The clean-state defect is missing account lifecycle invalidation. A lingering Connected row after legacy disconnect is not necessarily stale: the frozen snapshot explicitly considers OpenAI available while accounts exist, but reports them as `custom`/ChatGPT and offers a misleading legacy disconnect action. Both observations expose incomplete integration between account sources and the provider lifecycle/UI, but a legacy-only stale-cache defect is not reproduced. The real HTTP regression confirms that legacy-only disconnect removes OpenAI, while disconnect with an eligible account correctly retains availability. The original VM's exact stale-instance state cannot be reconstructed from its notification alone.

## M12 HTTP 400 assessment

No direct evidence links the availability defect to the observed remote HTTP 400. Stale availability can hide models, retain a selectable row, or prevent model lookup. It does not itself construct an upstream HTTP request. A cached provider can retain loader/options/model state until invalidated, so it was a reasonable investigation lead; the current invalidation correction removes that stale lifecycle state without changing transport behavior.

Profile language/SDK caches include the exact profile ID, profile acquisition overrides the legacy fetch hook, and dispatch/refresh reads that profile's current credential. A configured credential/routing conflict fails locally rather than becoming a remote HTTP 400. Successful usage or OAuth refresh establishes neither inference-model compatibility nor request validity. Failures after reauthentication and in a fresh correctly bound session weaken the stale-instance hypothesis further. The dogfood 400 remains unresolved; there is no demonstrated causal basis for changing request construction in this checkpoint.

## Files and regression coverage

Production and contracts:

- `packages/opencode/src/kilocode/provider/availability.ts`: supported read-only account eligibility.
- `packages/opencode/src/provider/provider.ts`: source distinction, existing-source precedence, eligibility hook.
- `packages/opencode/src/kilocode/server/httpapi/handlers/provider-accounts.ts`: auth lifecycle invalidation after successful OAuth completion/removal.
- `packages/kilo-vscode/src/KiloProvider.ts`: account mutation refresh of cached providers/models.
- `packages/kilo-vscode/webview-ui/src/context/provider-utils.ts`: shared availability predicate.
- `packages/kilo-vscode/webview-ui/src/components/shared/ModelSelector.tsx`: consume the same predicate.
- `packages/kilo-vscode/webview-ui/src/components/settings/ProvidersTab.tsx`: minimal profile-source label/action behavior.
- `packages/kilo-vscode/webview-ui/src/types/messages/providers.ts`: profile-source contract.
- `packages/sdk/js/script/build.ts`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `packages/sdk/openapi.json`: generator and regenerated Provider source compatibility.
- `.changeset/provider-account-availability.md`: user-facing patch release note.

Tests:

- `packages/opencode/test/kilocode/server/provider-accounts-lifecycle.test.ts`: real profile store, provider service/cache, instance disposal, account routes, legacy auth routes, and `/provider` availability matrix. Covers zero/one/multiple profiles; removal of one/final account; mixed legacy/profile sources; legacy-only disconnect; rename/default invariance; reauth stability; disposal notifications; and clean-state profile-only language acquisition.
- `packages/opencode/test/kilocode/provider/availability.test.ts`: opt-in eligibility, expired-but-refreshable accounts, invalid credentials, unchanged credential revisions/defaults.
- `packages/opencode/test/kilocode/qualification/normal-acquisition.test.ts`: real persisted unbound/bound sessions stay unchanged by availability/default/removal, and defaults remain new-session-only. Existing exact-profile fail-closed acquisition test remains intact.
- `packages/opencode/test/kilocode/server/provider-auth-fixture.ts`: real invalidation services for isolated route fixtures.
- `packages/opencode/test/kilocode/server/provider-account-usage-api.test.ts`, `packages/opencode/test/kilocode/qualification/reauth-route.test.ts`, `packages/opencode/test/kilocode/qualification/usage-security-api.test.ts`: supply those lifecycle dependencies.
- `packages/kilo-vscode/tests/unit/kilo-provider-provider-refresh.test.ts`: host add/reauth/remove push refreshed authoritative models; metadata changes do not refetch.
- `packages/kilo-vscode/tests/unit/provider-utils.test.ts`: selector/validity availability agrees across connection sources.
- This checkpoint report: `.kilo/plans/provider-account-availability-checkpoint.md`.

## Validation

Commands below omit the temporary PATH prefix used to select cached Bun 1.4.2. HTTP/server/build commands ran outside the filesystem/network sandbox where required.

| Directory | Exact command | Result |
|---|---|---|
| Root | `bun install --frozen-lockfile --ignore-scripts` | PASS; lockfile unchanged. |
| Root | `./script/generate.ts` | PASS; SDK/OpenAPI regenerated. |
| Root | `bun run typecheck --concurrency=2` | PASS; all 30 package tasks. |
| Root | `GOMEMLIMIT=1GiB GOGC=50 bun run lint` | PASS; 0 errors, 11,308 warnings across the existing repository. |
| `packages/kilo-vscode` | `bun run format` | PASS; no unrelated tracked formatting changes. |
| `packages/kilo-vscode` | `bun run compile` | PASS; CLI preparation, SDK preparation, host/webview typechecks, ESLint, and bundles. The missing `bunx` wrapper triggered the script's existing fallback to active Bun 1.4.2. |
| `packages/opencode` | `du -h dist/*/*/bin/kilo` | Built Linux x64 CLI artifact: 269M. |
| `packages/kilo-vscode` | `bun test tests/unit/provider-*.test.ts tests/unit/model-selector-utils.test.ts tests/unit/kilo-provider-provider-refresh.test.ts tests/unit/kilo-provider-catalog.test.ts tests/unit/kilo-provider-utils.test.ts` | PASS; 282 tests, 639 assertions, 14 files. |
| `packages/core` | `bun test test/kilocode/provider-account-profiles.test.ts test/kilocode/provider-profile-dispatch.test.ts test/kilocode/provider-profile-refresh.test.ts test/kilocode/provider-profile-qualification.test.ts test/kilocode/provider-profile-admission-qualification.test.ts test/kilocode/session-binding.test.ts` | PASS; 22 tests, 216 assertions, 6 files. |
| `packages/opencode` | `bun test ./test/kilocode/session-authority-qualification.test.ts` | PASS in isolation; 5 tests, 93 assertions. |
| `packages/opencode` | `bun test ./test/kilocode/server/provider-auth-lifecycle.test.ts ./test/kilocode/server/provider-accounts-lifecycle.test.ts ./test/kilocode/server/provider-accounts-api.test.ts ./test/kilocode/server/provider-account-usage-api.test.ts ./test/kilocode/provider/availability.test.ts ./test/kilocode/qualification/normal-acquisition.test.ts` | PASS; final focused run: 10 tests, 211 assertions, 6 files. |
| Root | `bun run script/check-opencode-annotations.ts --worktree` | PASS. |
| Root | `bun run script/check-opencode-promise-facades.ts` | PASS; no runtime facade drift. |
| `packages/kilo-vscode` | `bun run knip` | PASS. |
| `packages/kilo-vscode` | `bun run check-kilocode-change` | PASS. |
| Root | `bun run script/check-md-table-padding.ts` | PASS. |
| Root | `git diff --check` | PASS. |

The final broad backend command, from `packages/opencode`, was:

```sh
bun test ./test/kilocode/qualification/ \
  ./test/kilocode/session-authority-qualification.test.ts \
  ./test/kilocode/server/provider-auth-lifecycle.test.ts \
  ./test/kilocode/server/provider-accounts-lifecycle.test.ts \
  ./test/kilocode/server/provider-accounts-api.test.ts \
  ./test/kilocode/server/provider-account-usage-api.test.ts \
  ./test/kilocode/provider/availability.test.ts \
  ./test/provider/provider.test.ts
```

Result: **171 passed /1 failed, 1,446 assertions, 28 files**. The failure is the existing `session provider authority qualification > traces hostile provider errors through real session HTTP, messages, events, replay, and export` assertion at `session-authority-qualification.test.ts:517`: its aggregate execution records no upstream request where the test expects `Bearer SECRET_ACCESS_A`. All added availability/lifecycle/binding tests and the other exact-profile fail-closed qualification cases pass.

Unchanged frozen snapshot control: extract `git archive HEAD packages/opencode` from `99915bc7b3` into an ignored workspace cache, retain the same installed dependencies and unchanged companion packages, then execute from its `packages/opencode`:

```sh
bun test ./test/kilocode/qualification/ ./test/kilocode/session-authority-qualification.test.ts
```

Result: **61 passed /1 failed, 1,003 assertions, 22 files**, with the same test and missing-upstream assertion. The corrected file passes **5/5** when run alone. This establishes that the aggregate failure is already present in the frozen sources; it is reported rather than weakened or expanded into an unrelated qualification-harness correction. The complete aggregate suite is not claimed green.

Initial unrestricted-concurrency typechecking and lint processes were terminated with `SIGKILL` while several memory-intensive checks ran together. Typechecking passed with two concurrent packages; lint passed with the Go memory/GC settings above. Sandbox restrictions on local listeners, CLI state initialization, and Gradle cache writes were resolved by approved execution outside the sandbox.

No new production source URLs or workflow/config keys were added; source-link extraction, workflow allowlist updates, and cloud-schema changes are not applicable.
