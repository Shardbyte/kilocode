# UPA-0 authentication characterization and proposed contracts

Status: bounded characterization checkpoint; contracts below are proposals for human review. No UPA-1 runtime change is implemented. Baseline observations refer to `217bcaeb91ea3692eb36bffc2f0ee19503b5d705`.

## Provenance and scope

| Item | Starting observation |
|---|---|
| Origin | `git@github.com:Shardbyte/kilocode.git` for fetch and push |
| Branch | `feat/provider-account-profiles` |
| Full HEAD | `217bcaeb91ea3692eb36bffc2f0ee19503b5d705` |
| Current checkout | `/home/saint/projects/research/kilocode`, attached branch, main checkout in `git worktree list --porcelain` |
| Latest M12 checkpoint | HEAD itself: `feat(cli): add bounded profile Codex diagnostics` |
| Committed and pushed | HEAD is committed; read-only `git ls-remote origin refs/heads/feat/provider-account-profiles` independently returned the same full SHA |
| Starting index | No staged or tracked changes |
| Starting untracked state | `codex-session-01a11e54-2b48-7da0-8304-bec00d04acb6.md`; never read, staged, moved, or deleted by this task. It disappeared externally during execution. |
| Other worktrees | Existing detached and diagnostic worktrees were listed only; none were changed |

The initial remote lookup failed on sandbox SSH configuration permissions; the approved read-only retry succeeded. No reset, rebase, merge, push, live OAuth, live inference, operator credential retrieval, dependency installation, or VSIX rebuild occurred. Synthetic protocol tests replace fetch before requesting OAuth endpoints and use temporary stores; localhost callback tests never contact a live OAuth service.

All changes are new tests under Kilo-owned paths and this review packet. Every tracked source file, existing test, diagnostic activation control, and report behavior remains unchanged. No changeset is needed because this checkpoint changes neither product behavior nor user-facing features.

The ending commit and full file inventory are recorded by the checkpoint commit itself and reported separately after committing; embedding that commit's own SHA would be self-referential. The validation and ending-state ledger appears below.

## Source ownership matrix: implemented behavior

Paths in this packet are relative to the repository root. The legacy CLI provider path and core V2 integration path coexist; neither is a universal representation of all authentication sources.

| Source / store | Writer | Reader / consumer | Refresh owner | Identity and inference dispatch |
|---|---|---|---|---|
| Legacy OAuth in `auth.json` | `packages/opencode/src/auth/index.ts` `Auth.set`; `ProviderAuth.callback`; legacy CLI auth callers; core Credential writeback | `Auth.get/all`; `Provider.Service`; Codex plugin loader; core startup reconciliation | Codex loader invokes `kilocode/provider/codex-refresh.ts` with file coordination and SDK `client.auth.set`; core Integration can independently refresh its SQL copy | Provider-wide `openai` slot, optional `accountId`; legacy Codex fetch rereads current auth on each request, rewrites to ChatGPT Responses, injects current bearer/account header |
| Legacy API key in `auth.json` | `Auth.set`; API auth routes/callers; core Credential writeback | Auth, CLI provider discovery/SDK configuration; core Credential importer | No OAuth refresh | Provider-wide key slot; CLI may resolve environment/config routing, core has a credential ID; neither pins historical CLI key identity |
| `Credential.Service` SQL records | `packages/core/src/credential.ts` create/update/remove, `legacyImportLayer`, Integration settlement and refresh | Integration connections, core session runner, core catalog/usage; profile activation reads its list | `Integration.connection.resolve` calls registered method refresh within five minutes of expiry and then updates Credential | Credential ID + integration ID + OAuth method ID; create replaces the integration's stored credentials; normal mutations dual-write latest credential to JSON, subject to profile import suppression |
| Core environment connection | Integration environment connection projection | `Integration.connection.resolve`, `session/runner/model.ts`, plugin host | None for key; process runtime supplies value | Environment connection identity, separate from stored credential identity; active connection ordering selects the connection before resolution |
| `KILO_AUTH_CONTENT` injection | Operator process environment, Credential process-local mutations | Auth reads JSON content; Credential builds process-local records | Legacy callers may attempt refresh; Credential changes stay local | Auth and Credential isolation semantics differ: Auth set/remove still write the resolved JSON file; Credential does not write durable storage when injected content is defined |
| Provider environment/config key | Environment/config, provider loader | CLI `Provider.Service` and core catalog/provider request options | None | CLI SDK selection uses provider/model and resolved options; this authority is not represented by a profile ID |
| Provider Account OAuth | `packages/core/src/kilocode/provider-account-profiles.ts` create/reauthenticate/CAS; profile HTTP OAuth completion; automatic import | Profile HTTP projection, `provider/availability.ts`, usage, exact-profile CLI SDK fetch | `kilocode/provider/codex-profile.ts` refresh with per-profile SQL refresh lock and revision-checked reauthenticate | Stable local `pacc_…` ID, optional strong remote identity, separate secret revision; exact profile ID precedes refresh and transactional dispatch |
| Legacy well-known auth | Auth/config bootstrap | Bootstrap/config consumers; Credential importer excludes it | Source-specific bootstrap | Not a model credential; must not be flattened into provider API/OAuth inference authority |

`ProviderAccountProfiles.Info` is secret-free metadata. Secrets live in `kilo_provider_account_credential`, defaults in `kilo_provider_account_default`, and the import marker in `kilo_provider_account_import`. Profile lifecycle and secret revisions are not equivalent: rename changes metadata time without advancing credential revision; defaults have no secret revision. Removal cascades profile-owned rows but leaves persisted session metadata and retained legacy stores.

## Concrete call graphs

### Legacy CLI browser and device OAuth

```text
ProviderAuth.authorize (packages/opencode/src/provider/auth.ts)
  -> plugin auth.methods[index].authorize
  -> CodexAuthPlugin (packages/opencode/src/plugin/openai/codex.ts)
     browser: startCodexOAuth -> localhost state/PKCE callback -> token exchange
              -> completeCodexOAuth -> success result
     device: usercode -> deviceauth/token polling -> authorization-code exchange
             -> success result
ProviderAuth.callback
  -> Auth.Service.set("openai", OAuth result) -> auth.json
  -> ModelCache.clear; HTTP auth lifecycle also disposes cached instances
Provider.Service discovery
  -> CodexAuthPlugin.provider.models(..., { auth: Auth.get("openai") })
  -> auth.loader(getAuth)
  -> each request rereads current provider-wide auth
     -> expired: refreshCodexAuth -> token exchange -> SDK client.auth.set
     -> current bearer/account header -> ChatGPT Responses transport
```

The shared browser protocol helper returns credential material but does not decide persistence. The legacy caller writes Auth; the profile caller writes profiles. Legacy device OAuth remains a separate method in CodexAuthPlugin. No profile device/headless endpoint currently exists.

### Core browser and headless OAuth

```text
OpenAIPlugin (packages/core/src/plugin/provider/openai.ts)
  -> register chatgpt-browser / chatgpt-headless with Integration.Service
Integration.connection.oauth -> registered authorize
  browser: scoped localhost callback -> PKCE exchange
  headless: usercode -> polling -> PKCE exchange
  -> auto callback fiber -> Integration.settle
  -> Credential.create -> SQL credential + conditional auth.json writeback
Integration.connection.active -> exact connection selection
  -> connection.resolve -> registered refresh if expiring -> Credential.update
  -> core session/runner/model.ts -> resolved request credentials
```

Core catalog availability in `packages/core/src/catalog.ts` depends on request API-key configuration or integration connections. Its OpenAI plugin disables `gpt-5-chat-latest` and uses Responses; it does not implement the CLI Codex OAuth model policy. Do not infer that core and legacy CLI discovery share policy.

### Profile browser OAuth, activation, refresh, and dispatch

```text
App graph ProviderAccountProfiles.activation
  -> Credential.node startup legacyImportLayer reconciles auth.json
  -> importStoredLegacy -> first openai chatgpt-browser SQL OAuth
  -> importLegacy immediate SQL transaction (profile + secret + default + marker)
HTTP /provider-accounts/oauth/start or /:accountID/oauth/start
  -> makeOAuthFlow remembers label OR exact target ID + expected secret revision
  -> startCodexOAuth -> correlated completion
HTTP /provider-accounts/oauth/complete
  -> create OR reauthenticate exact target (revision + remote identity checks)
  -> clear OpenAI ModelCache -> dispose all InstanceStore entries
Session.create -> persist default profile snapshot or explicit unbound state
Session.ensureBinding -> persisted entry OR historical import-marker interpretation
LLM / UtilityAccount admission -> resolveBinding -> Provider.getLanguage(model, profileID)
  -> SDK cache key includes profile ID; skip environment secret resolution
  -> codexProfileFetch -> withRefresh(exact ID) -> reauthenticate revision
  -> dispatch(exact ID) reads current secret transactionally at handoff
  -> ChatGPT Responses fetch with exact profile bearer/account header
```

Profile dispatch releases the SQLite transaction before the response settles. A profile deleted after language acquisition fails closed at refresh/dispatch, without fallback. Profile SDK setup rejects conflicting configured API key, base URL, and authorization header overrides. M12 diagnostic observation stays in the existing transport path unchanged.

### Session, utility, and extension consumers

`packages/core/src/kilocode/session-binding.ts` defines persisted V1 entries and replacement rules. `packages/opencode/src/session/session.ts` snapshots defaults at creation, preserves binding metadata through generic updates and inheritance, and uses exclusive coordination for assignment/repair. Healthy profile and explicit legacy bindings cannot be replaced; missing-profile repair requires explicit confirmation. Deleting a profile does not rewrite a session or select another account.

Legacy entries store mode/authMode/source and sometimes remote account ID, but `resolveBinding` reduces them to `{ mode: "legacy" }`; legacy transport then rereads provider-wide Auth. Defaults therefore pin profiles but do not pin legacy/API/environment authority. `ensureBinding` can assign a historical missing entry from the import marker; that current behavior is not accepted as proof of historical authority and must not be expanded by UPA-1.

`kilocode/provider/utility-account.ts` admits explicit account, source-session, or explicit legacy contexts according to operation, directory, and project. Source-session utilities inherit that session's authority; standalone utilities cannot silently use the current default. Identity is revalidated before dispatch; a model choice is not an account choice.

`packages/kilo-vscode/src/KiloProvider.ts` handles `providerAccounts` actions, calls SDK list/start/complete/reauthenticate/rename/remove/default/usage/session routes, and posts `providerAccountsLoaded` with session correlation. OAuth completion rereads account list and binding and refreshes provider state. `src/provider-accounts.ts` validates account/binding DTOs, redacts errors, allowlists browser authorization URLs, and discards stale session responses. `webview-ui/src/types/messages/provider-accounts.ts` supplies the message shapes. The current `canRepair` helper infers repair from absence in the listed IDs; it cannot distinguish listing failures, missing secrets, identity mismatch, disabled features, or active turns. Backend assignment still enforces authoritative checks. No UI change is proposed in UPA-0.

## Source-specific model metadata inventory

| Context | Implemented policy | Provenance / limits |
|---|---|---|
| CLI legacy OAuth | Codex plugin keeps explicit allowlist plus future GPT majors/minors, excludes reasoning mode `pro`, `gpt-5.5-pro`, bare `gpt-5.6`, and unmatched IDs | Predicate is local compatibility policy, not upstream account entitlement |
| CLI legacy OAuth prices | All retained models get zero input/output/cache read/write cost | Subscription display/accounting adjustment; not an assertion of free upstream usage |
| CLI legacy OAuth limits | Local IDs containing `gpt-5.5`: context 400,000, input 272,000, output 128,000; containing `gpt-5.6`: context 1,050,000, input 922,000, output 128,000 | Bare 5.6 is excluded first; variants such as 5.6-sol receive the limit. Other models retain catalog limits, including GPT-6 Luna. Filtering uses API ID while overrides inspect local ID. |
| CLI API key or profile-only | Codex `provider.models` returns the input models unchanged when `ctx.auth` is not OAuth | Profile presence does not supply OAuth policy context; catalog/config prices and limits survive |
| Mixed API key + profile | Provider source remains `api`; discovery receives API auth | Profile dispatch remains exact-profile OAuth when explicitly selected; shared discovery metadata is not source-specific |
| Mixed legacy OAuth + profile | Provider source is `custom` in the characterized no-config fixture, with legacy OAuth policy | Legacy presence can change metadata even when inference is profile-bound |
| Profile-only discovery | `eligible` checks a real account credential, account identity, and live access or refresh token; then exposes source `profile` if OpenAI is not already available | Does not select a default or mutate a binding; does not run the Codex OAuth metadata policy |
| Provider/config/global filtering | enabled/disabled providers, whitelist/blacklist, alpha/deprecated status, chat aliases, config models/variants | Config extension follows plugin policy and can affect final catalog; policy-hook tests and integrated discovery tests have separate scopes |
| Core V2 catalog | Integration availability and provider request metadata; OpenAI Responses compatibility hides `gpt-5-chat-latest` | Distinct catalog implementation, not proof of CLI profile-compatible models |

No synthetic auth object should be introduced to make the existing hook filter profile models. The future contract should parameterize explicit source policy and project effective metadata without resolving a secret. Mixed sources cannot be collapsed into a single provider-wide cost/limit/filter result.

## Confirmed hazards

1. Automatic activation duplicates an OAuth lineage across Auth JSON, Credential SQL, and profile SQL, without ownership transfer or legacy deletion. Profile refresh does not update the retained copies. Tests show profile revision advancement while the original legacy secret remains unchanged.
2. Profile refresh has an account-scoped SQL lock/CAS; legacy Codex has file coordination; Integration resolve independently calls method refresh and updates Credential. These locks do not establish one writer across copies of an imported lineage. Token rotation conflicts are a concrete architectural hazard; no live rotation race was exercised here.
3. A completed empty import marker permanently suppresses later OpenAI OAuth reconciliation while profiles are enabled, and later import will not create a profile. API-key reconciliation still works. The marker is neither credential lineage nor a recoverable transfer journal.
4. A headless Credential writeback loses its method ID in auth.json. Next reconciliation normalizes it to `chatgpt-browser` and automatic profile import can copy it. Direct `importStoredLegacy` recognizes browser method only; this cannot be used to claim headless provenance survives startup.
5. Feature disablement lets legacy reconciliation resume; reenablement preserves the existing profile lineage and marker. Stores can then refer to different remote identities without a shared ownership contract.
6. Persisted legacy mode permits source replacement after binding: the same acquired loader dispatches A, then B after Auth replacement, while binding metadata stays unchanged. Remote account hints are not enforced legacy authority.
7. Historical missing authority may be inferred from the import marker by current `ensureBinding`. Unknown historical authority must instead fail closed or require explicit operator action in the reviewed future contract; do not rewrite historical sessions automatically.
8. Profile-only and API-key discovery bypass OAuth filtering/cost/limit overrides; legacy OAuth presence can govern discovery for profile inference. Mere profile existence is not model eligibility or entitlement.
9. Profile public `revision` means secret revision only, while rename/default/deletion and caches have distinct lifecycle semantics. Wall-clock metadata timestamps cannot safely substitute for a monotonic lifecycle revision.
10. Client-derived missing-ID repair eligibility is incomplete. The backend must derive reasoned eligibility, source availability, binding revision, and active-turn constraints and recheck them atomically on mutation.
11. Auth and Credential disagree on injected-content persistence and malformed-content handling; treating them as one environment authority would conceal this distinction. The checkpoint never injects operator material.

## Draft TypeScript contracts (proposal only)

These declarations are intentionally documentation, not exported runtime or SDK types. Opaque IDs are backend-issued identifiers, never secret values, bearer fingerprints, arbitrary environment contents, or token-derived hashes. Remote identity remains optional metadata, separate from local source identity.

```ts
type Mode = "api-key" | "chatgpt-oauth"
type Revision = number // monotonic within the corresponding source/binding lifetime

// 1. Secret-free reference: store-specific identity is retained.
type Source =
  | { kind: "profile"; provider: string; mode: "chatgpt-oauth"; id: string }
  | { kind: "legacy"; provider: string; mode: Mode; id: string; generation: Revision }
  | { kind: "credential"; provider: string; mode: Mode; id: string; method?: string }
  | { kind: "environment"; provider: string; mode: Mode; id: string; scope: string }
  | { kind: "config"; provider: string; mode: "api-key"; id: string; generation: Revision }

// 2. Independent lifecycle and credential changes, without secret resolution.
interface Status {
  source: Source
  lifecycle: Revision
  credential: Revision | null // null = not versioned/resolvable, never fabricated zero
  state: "ready" | "refreshable" | "reauth-required" | "missing" | "disabled" | "identity-mismatch"
  owner: "profile" | "legacy" | "integration" | "external" | "unknown"
  lineage: string | null // backend-established ownership lineage, not token inspection by UI
}

// 3. Source-specific effective metadata; eligibility is not entitlement.
interface Metadata {
  source: Source
  provider: string
  model: string
  api: string
  policy: { id: string; revision: Revision }
  compatibility: "supported" | "unsupported" | "unknown"
  reason?: "transport" | "model-policy" | "routing-conflict" | "source-unavailable"
  entitlement: "unknown" // local policy alone never proves upstream access
  limit: { context: number; input?: number; output: number }
  cost: { input: number; output: number; cache: { read: number; write: number } }
  basis: "catalog" | "config" | "oauth-policy"
}

// 4. Persist exact authority, including key/env/legacy; never a mutable default.
type Authority =
  | { state: "bound"; source: Source; lifecycle: Revision; provenance: "explicit" | "default" | "inherited" | "repair" }
  | { state: "unbound"; reason: "selection-required" | "historical-unknown" }

interface Binding {
  version: 2
  revision: Revision
  providers: Readonly<Record<string, Authority>>
}

// 5. Recoverable ownership transfer. No secret is carried in this projection.
interface Transfer {
  operation: string
  lineage: string
  from: Extract<Source, { kind: "legacy" | "credential" }>
  to: Extract<Source, { kind: "profile" }>
  expected: { lifecycle: Revision; credential: Revision }
  phase: "prepared" | "copied" | "owner-committed" | "needs-recovery" | "aborted"
  owner: "legacy" | "integration" | "profile"
  retained: boolean // preserve legacy credential data; never implies permission to delete
}

interface Transfers {
  prepare(source: Transfer["from"], expected: Transfer["expected"]): Promise<Transfer>
  resume(operation: string): Promise<Transfer>
  abort(operation: string): Promise<Transfer> // no automatic rollback of a committed owner
}

// 6. Backend computes eligibility and mutations recheck the exact revisions.
interface Eligibility {
  session: string
  provider: string
  binding: Revision
  authority: Authority
  assign: boolean
  repair: boolean
  confirmation: boolean
  reason: "unbound" | "healthy" | "missing" | "disabled" | "reauth-required" | "historical-unknown" | "turn-active" | "conflict"
  targets: ReadonlyArray<{ source: Source; lifecycle: Revision }>
}
```

These shapes deliberately retain API-key, legacy, environment, config, and SQL credential sources rather than coercing all into OAuth. Environment scope must be reproducible and backend-resolvable; a restarted process that cannot prove the bound scope fails closed. Legacy Auth JSON currently lacks a stable generation; the review must choose how the existing stores establish one before claiming source replacement can be detected. A source ID/generation cannot simply be minted anew on every read or inferred from remote account ID.

A lifecycle revision advances for lifecycle/availability/ownership mutations; a credential revision advances for secret rotation or reauthentication. Defaults have separate selection state and must not advance or rewrite historical bindings. Effective metadata carries a policy revision because catalog/policy changes differ from either source revision.

Transfer preparation requires explicit operator authorization and version checks. Copying alone must leave the old owner active and the new copy non-dispatchable; ownership commit must fence the old refresh writer before enabling the profile writer. Resume must be idempotent after process failure. Retaining legacy data does not authorize two refresh writers. Abort before commit may abandon a prepared target; after commit it requires explicit recovery. Use the existing account/import/credential tables and reviewed transaction/coordination mechanisms, not a new persistent registry or credential store. Existing marker fields cannot express these phases; any schema extension requires a separately reviewed implementation boundary and crash tests.

The proposal's Promise signatures describe ports, not permission to introduce runtime-backed Promise facades in shared Effect services. Implementations should use service dependencies and existing AppRuntime/Kilo-owned boundaries.

## Proposed UPA-1 boundary for review

Propose one bounded change: route **new ChatGPT browser and headless OAuth sign-ins** through canonical Provider Accounts persistence, reusing protocol primitives while making persistence destinations explicit. Account creation must enforce identity/label rules and preserve correlated cancellation, TTL, completion, and reauthentication semantics. Backend source/status/model projections should be additive and secret-free, derive policy for the exact selected source, and retain separate lifecycle and credential revisions.

Before implementing that boundary, review how legacy generation, environment scope, and cross-store ownership can be proven. Activation's existing automatic copy must not be mistaken for transfer. A follow-up must explicitly decide whether to replace automatic copying with compatibility-only activation; UPA-0 authorizes no such change. New sign-ins must not mirror credentials into auth.json, fabricate an OAuth auth object for model filtering, or derive eligibility merely from a profile's existence.

UPA-1 must preserve legacy compatibility, existing exact-profile refresh/dispatch, current binding immutability, and M12 diagnostics. It must not implement automatic credential deletion, transfer historical sessions, infer historical authority, rotate/fallback between accounts, add a registry/store, redesign UI, or run live accounts. Explicit recoverable transfer and legacy/API/environment V2 binding adoption are separate reviewable work after identity/ownership proof is accepted; do not claim the entire six-contract architecture is delivered by routing new sign-ins.

## Characterization coverage

| Area | Added or retained executable evidence |
|---|---|
| Activation and automatic legacy copy | New core `upa-auth-characterization.test.ts`: flag off/on, unchanged JSON, idempotent restart |
| Marker and reconciliation | New core tests: empty marker, late OAuth suppressed, API key retained; existing `credential.test.ts` and profile import rollback/removal tests |
| Headless completion and provenance | New core `upa-oauth-characterization.test.ts`: real OpenAI headless protocol implementation with synthetic fetch, Integration settlement into Credential; new auth test shows method loss on JSON reconciliation |
| Independent refresh lineage | New core test uses real reauthenticate revision and restart, retains stale legacy copies, checks disable/re-enable reconciliation; existing profile refresh/usage/identity tests |
| Legacy replacement after persisted binding | New CLI `upa-auth-characterization.test.ts`: real Session + Auth + acquired Codex loader, A then B transport, unchanged persisted binding |
| Default immutability and deletion | Existing `qualification/normal-acquisition.test.ts`: real persisted sessions and language acquisition, default changes/deletion do not rewrite binding, exact-profile deletion fails closed |
| Mixed discovery and metadata | New CLI tests: real provider discovery for API/OAuth/profile-only with a stored profile; actual Codex policy hook filtering, costs and limits without source fabrication |
| Browser/device completion and persistence | New CLI test exercises the actual Codex device method and ProviderAuth callback into Auth, with no profile creation; existing `provider/codex-oauth.test.ts` exercises synthetic localhost browser callbacks; `server/provider-accounts-lifecycle.test.ts` exercises real profile persistence and identity/revision rejection with a protocol adapter |
| Lifecycle invalidation | Existing lifecycle HTTP test primes discovery before create, observes invalidation on completion/reauth/delete, confirms rename/default do not publish invalidation |
| Protected diagnostics | Existing `provider/codex-diagnostic.test.ts` included unchanged in the focused suite |

Protocol-boundary fixtures replace network responses, not authentication implementation or persistence logic. Policy-hook fixtures intentionally supply minimal model records; integrated discovery uses the real provider and bundled test catalog. No assertion in an existing qualification test has changed. Source-inspected behavior is explicitly distinguished from exercised tests, and no synthetic test proves live entitlement or resolves the operator's HTTP 400.

## Validation and ending-state ledger

Pinned existing Bun **1.4.2 (744846f84)** via `PATH=/tmp/kilo-corrective-bin:$PATH`; installed dependencies and lockfile unchanged. New characterization cases: **12** across three files. No existing test or assertion was edited.

| Check | Exact final result |
|---|---|
| Core focused suite | 43 passed, 0 failed, 229 assertions, 7 files; exit 0 |
| CLI focused suite, including unchanged M12 diagnostic tests | 107 passed, 0 failed, 563 assertions, 9 files; exit 0 |
| Aggregate qualification baseline control | 63 passed, 1 failed, 1,074 assertions, 22 files; exit 1 |
| Core `bun run typecheck` | Passed, exit 0 |
| CLI `bun run typecheck` | Passed, exit 0 |
| Targeted root lint | 0 errors, 11 warnings for minimal protocol/policy fixture type assertions, exit 0 |
| Prettier check, three new test files | Passed, exit 0 |
| `check-opencode-annotations.ts --worktree` | Passed; no shared upstream source files changed |
| `check-md-table-padding.ts` | Passed; 392 Markdown files checked at the final guard run |
| `git diff --check` / staged whitespace check | Passed |

The aggregate failure is precisely the pre-existing `session provider authority qualification > traces hostile provider errors through real session HTTP, messages, events, replay, and export` at `packages/opencode/test/kilocode/session-authority-qualification.test.ts:517`, expecting the synthetic A bearer where the upstream request list is empty. Its unchanged 63/1 result matches [M12 request correction](m12-codex-request-correction.md); the earlier independent frozen-baseline control remains in [availability checkpoint](provider-account-availability-checkpoint.md). It is **not fixed**, waived, or made green by focused results.

Core commands run from `packages/core/` with `XDG_DATA_HOME=/tmp/upa0-core/data`, `XDG_STATE_HOME=/tmp/upa0-core/state`, `XDG_CACHE_HOME=/tmp/upa0-core/cache`, and `XDG_CONFIG_HOME=/tmp/upa0-core/config`. The repository preload forces an in-memory default database; persistence tests override it with temporary paths and all Credential layers use synthetic temporary data directories. An initial core run failed before executing tests because Global initialization tried a sandbox-protected state directory; rerunning with isolated XDG directories resolved it without reading operator stores.

```sh
bun test ./test/kilocode/upa-auth-characterization.test.ts ./test/kilocode/upa-oauth-characterization.test.ts ./test/kilocode/provider-account-profiles.test.ts ./test/kilocode/session-binding.test.ts ./test/credential.test.ts ./test/integration.test.ts ./test/plugin/provider-openai.test.ts
bun run typecheck
```

CLI commands run from `packages/opencode/`; its preload redirects XDG, test home/config, and storage. The focused suite first hit EPERM loopback-listener restrictions (95 pass / 11 fail); approved loopback execution resolved those restrictions. Final results above reflect the complete rerun after the device-persistence case was added.

```sh
bun test ./test/kilocode/upa-auth-characterization.test.ts ./test/kilocode/qualification/normal-acquisition.test.ts ./test/kilocode/server/provider-accounts-lifecycle.test.ts ./test/kilocode/provider/account-usage.test.ts ./test/kilocode/provider/codex-profile.test.ts ./test/kilocode/provider/codex-oauth.test.ts ./test/kilocode/provider-account-oauth.test.ts ./test/plugin/codex.test.ts ./test/kilocode/provider/codex-diagnostic.test.ts
bun test ./test/kilocode/qualification/ ./test/kilocode/session-authority-qualification.test.ts
bun run typecheck
```

Root checks:

```sh
bun run lint packages/core/test/kilocode/upa-auth-characterization.test.ts packages/core/test/kilocode/upa-oauth-characterization.test.ts packages/opencode/test/kilocode/upa-auth-characterization.test.ts
bun node_modules/.bin/prettier --check packages/core/test/kilocode/upa-auth-characterization.test.ts packages/core/test/kilocode/upa-oauth-characterization.test.ts packages/opencode/test/kilocode/upa-auth-characterization.test.ts
bun run script/check-opencode-annotations.ts --worktree
bun run script/check-md-table-padding.ts
git diff --check
git diff --cached --check
```

Complete changed-file inventory (all additions):

- `.kilo/plans/upa-0-authentication-contract-review.md`
- `packages/core/test/kilocode/upa-auth-characterization.test.ts`
- `packages/core/test/kilocode/upa-oauth-characterization.test.ts`
- `packages/opencode/test/kilocode/upa-auth-characterization.test.ts`

Precommit HEAD remained exactly the required baseline. The commit is a single direct child on the same feature branch. Ending checks must show exactly these four additions versus the starting SHA, no tracked runtime or pre-existing test changes, an empty index and worktree (including untracked files), and the remote-tracking branch still at the starting checkpoint. Final full SHA is reported after commit. Temporary validation logs are `/tmp/upa0-core-tests.log`, `/tmp/upa0-cli-tests.log`, `/tmp/upa0-aggregate.log`, and `/tmp/upa0-lint.log`. No other checkout was modified. Stop here for human review; UPA-1 is not implemented and no push is authorized.
