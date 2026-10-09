# M12 temporary Codex HTTP diagnostics

Implemented against `763f9414f34e4bcd1f9ceda1e6c266714381caf4` on `feat/provider-account-profiles`. This implements the bounded lease proposed in [the earlier design](provider-account-http400-diagnosis.md). The final implementation commit is reported with the handoff; no VSIX is produced at this checkpoint.

## Findings

- Exact-profile acquisition still resolves the persisted binding, keys SDK/language caching by profile, replaces inherited fetch, and dispatches through that account only. Profile transport is HTTP Responses/SSE; legacy HTTP is also the default, with an optional legacy WebSocket pool. No fallback, default-account lookup, rotation, refresh change, or transport change is introduced.
- The accepted request-preparation correction derives effective OAuth context before `LLMRequestPrep.prepare`, supplies top-level Codex instructions, and omits generic system/developer message placement for profile OAuth just as for legacy OAuth. Profile preparation continues to receive no legacy credential.
- A deterministic extension of the actual shared preparer, Codex hooks, provider transformations, installed OpenAI Responses SDK, and both fetch adapters now checks `gpt-6-luna` with Low effort. Its catalog metadata has explicit effort values `none`, `low`, `medium`, `high`, `xhigh`, `max`; the test uses the actual `reasoningVariants` transformation. Both paths serialize `model:"gpt-6-luna"`, `reasoning.effort:"low"`, instructions, `store:false`, `stream:true`, and equal complete bodies/headers in the same fixture. The active diagnostic also records these actual SDK-produced wire values in that test.
- The reviewed snapshot catalog lists GPT-6 Luna with reasoning support, no temperature support, and context/input/output limits 1,050,000/922,000/128,000. This is metadata, not evidence of private Codex service admission or account entitlement. The operator's runtime catalog, overrides, utility variants, or serialized request can still differ; the diagnostic captures the actual serialized values.
- Profile-only catalog discovery still supplies `auth:undefined` to the legacy model hook and skips its OAuth compatibility filtering. The legacy hook nevertheless admits `gpt-6-luna` through its integer-major-version rule (`major > 5`). The test now establishes this admission alongside the existing filter discrepancy for other models. This rule is a local heuristic, not an authoritative upstream contract. GPT-6 Luna is neither declared supported nor unsupported here.
- GPT-5-specific default option branches in `ProviderTransform.options` do not directly cover GPT-6 Luna. Its explicit catalog effort variants use the shared OpenAI transformation (effort, reasoning summary, encrypted-reasoning include). For matching metadata and explicit Low selection, the real legacy/profile fixture has no remaining serialized parameter discrepancy. Configured options, entitlement, upstream compatibility, and the live rejection category remain unverified.
- A 400 alone is not attributed to missing instructions, stale cache, expired credentials, or model incompatibility. Only exact allowlisted error codes or status classes can yield a diagnostic category. There is no live evidence yet.

## Implementation and bounds

All production additions are in `src/kilocode/provider/`: `codex-diagnostic.ts` and a small observer integration in `codex-profile.ts`. No shared upstream production file, request preparation, filtering, auth state, or credential routing changed. No new API/SDK endpoint or config-schema key is needed.

The lease is disabled unless all three startup environment variables below are supplied. It selects one exact internal Provider Accounts profile ID, holds that ID only in memory, removes the profile variable from the backend environment before spawning further children, lasts at most ten minutes from module initialization, and reserves at most three exchanges, including retries or utility calls. A random operation UUID correlates the records; no profile/account/session label or hash is written. Expiry or stop cancels pending inspections and prevents late publication. A new process is needed for another operation.

Reports are local only, in a newly created file using exclusive creation and mode 0600 on POSIX. Existing files and symlinks are refused. Write failure disables diagnostics without changing inference. The file contains the latest bounded JSON report, not an append-only transport log. No telemetry/export or general logger is used.

Request inspection only reads an already serialized string body, with a 256 KiB UTF-8 limit and depth 16 limit; Request/Blob/stream bodies are uninspected and never consumed. Output includes approved field names and value types, instructions nonempty/present boolean, store/stream booleans, at most 128 input-role counts, a capped unknown-field count, and expected header presence booleans. Values, prompt lengths, schemas, metadata, arbitrary field names, headers, tokens, and account IDs are excluded. The model vocabulary deliberately contains only the two reviewed catalog IDs `gpt-5.4` and `gpt-6-luna`; other values become `unknown`. Reasoning effort is the actual wire enum (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), not an assumed UI selection. Unknown/custom variants become `unknown`.

Error inspection reads a response clone with a 4 KiB byte limit, depth 16, and deadline 250 ms. The caller receives the same original Response without awaiting diagnostics. Overflow, malformed input, timeouts, cancellation, unavailable streams, and unknown codes never expose bytes. Diagnostic tee cancellation is not awaited because it can wait for the caller's branch. Only exact `error.code` values are classified; arbitrary `message`, `type`, `param`, and other values are discarded. No free-text matching is used:

| Evidence | Category |
|---|---|
| 401/403, `invalid_api_key`, `token_expired` | authorization |
| `model_not_found`, `unsupported_model` | unsupported-model |
| `unsupported_parameter`, `unsupported_value` | unsupported-option |
| `missing_required_parameter` | missing-parameter |
| `invalid_request_error` as an exact code | invalid-request |
| HTTP 5xx | service-rejection |
| Transport promise rejection | transport-failure |
| Everything else | unknown |

A missing-parameter category does not identify which parameter; unsupported-model does not distinguish entitlement from broader compatibility. Header booleans are observations, not an inferred missing-header error. HTTP success and SSE contents are uninspected (`unknown`); this diagnostic targets HTTP rejection, not in-stream errors. Existing sanitized user-facing errors remain unchanged.

## Operator activation and deactivation

These are procedures for a later authorized operator reproduction, not actions executed during this checkpoint. The existing packaged snapshots do not contain this new capability. Run reviewed source, or a subsequently reviewed build; no new build/install is authorized here.

1. Obtain the exact internal profile ID from the existing session Provider Accounts binding or account record. Use its `profileID`/internal `id`, not its label or remote ChatGPT account ID. Do not export any credential record.
2. Choose a new absolute report path in a private local directory. The parent must already exist. Use a neutral filename; do not embed identifiers. Existing files are never overwritten.
3. Start the backend from the repository root with the environment set before process startup (Bun 1.4.2):

```sh
KILO_CODEX_DIAGNOSTIC=1 \
KILO_CODEX_DIAGNOSTIC_PROFILE='<internal-profile-id>' \
KILO_CODEX_DIAGNOSTIC_REPORT='/absolute/private/codex-diagnostic.json' \
bun dev serve --hostname 127.0.0.1 --port 4096
```

Connect the client to that backend using its existing external-backend workflow. If a later reviewed extension build starts its own backend, fully exit VS Code and launch it with the same environment so the newly spawned backend inherits the lease; a reload attaching to an older backend is insufficient. Windows PowerShell uses process-scoped environment variables before starting the client/backend:

```powershell
$env:KILO_CODEX_DIAGNOSTIC = '1'
$env:KILO_CODEX_DIAGNOSTIC_PROFILE = '<internal-profile-id>'
$env:KILO_CODEX_DIAGNOSTIC_REPORT = 'C:\private\codex-diagnostic.json'
# Start the reviewed backend/client from this process.
```

Do not place these controls in persistent extension settings or a config file. Make the operator's intended new-session GPT-6 Luna / Low request within ten minutes. Utility/title traffic on the same profile can use one of the three records; inspect all wire-model/effort values instead of assuming record order. Other profiles are ignored. No account changes, reset, reauthentication, switching, or automatic retry is needed to activate diagnostics.

Deactivate immediately by stopping the opted-in backend, unsetting the three variables, and restarting normally. For PowerShell, remove each with `Remove-Item Env:KILO_CODEX_DIAGNOSTIC`, `Remove-Item Env:KILO_CODEX_DIAGNOSTIC_PROFILE`, and `Remove-Item Env:KILO_CODEX_DIAGNOSTIC_REPORT`. For POSIX use `unset KILO_CODEX_DIAGNOSTIC KILO_CODEX_DIAGNOSTIC_PROFILE KILO_CODEX_DIAGNOSTIC_REPORT`. The lease also expires automatically after ten minutes; no further records are accepted after three. Starting again without the opt-in is disabled by default. Keep an existing safe report until reviewed; select a new filename for any separately authorized operation.

## Safe report retrieval

Read only the diagnostic file after the request finishes. It may be empty before any matching dispatch, or show status before the bounded inspection result arrives. Missing/empty reports can mean invalid controls, unavailable path, wrong profile, or no dispatch; they are not upstream diagnoses.

```sh
python3 -m json.tool /absolute/private/codex-diagnostic.json
```

On Windows: `Get-Content -Raw 'C:\private\codex-diagnostic.json' | ConvertFrom-Json | ConvertTo-Json -Depth 12`.

Share only that allowlisted report through the operator's chosen review channel. Do not retrieve backend logs, auth files, raw responses, network traces, or databases. There is no automated network export. If classification is `unknown`, preserve that uncertainty; do not enable raw logging.

## Validation

Commands use `PATH=/tmp/kilo-corrective-bin:$PATH` with pinned Bun 1.4.2 and the existing frozen dependencies. Package tests use the repository preload's temporary isolated state and synthetic accounts only.

From `packages/opencode/`:

```sh
bun test ./test/kilocode/provider/codex-diagnostic.test.ts ./test/kilocode/provider/codex-request-contract.test.ts ./test/kilocode/session-profile-error.test.ts
bun test ./test/kilocode/provider/codex-profile.test.ts ./test/kilocode/qualification/normal-acquisition.test.ts ./test/kilocode/session-authority-qualification.test.ts
bun run typecheck
```

Focused diagnostics/parity/sanitization: 25 passed, 0 failed (395 assertions). Authority/transport checks: 17 passed, 0 failed (204 assertions) after rerunning with permission for synthetic loopback listeners; the initial sandbox run had three EPERM listener failures. The broader qualification suite was not rerun; its previously documented baseline hostile-provider aggregate failure is not claimed fixed.

The new tests cover poisoned headers/credentials/prompts/errors/unknown keys and codes, serialized model/effort, byte/depth limits, malformed and oversized errors, chunked JSON, SSE pass-through, clone preservation, deadline/caller cancellation, expiry/pending cancellation, three-record reservation, exact-profile isolation, report-write failure, startup disabled/opt-in behavior, private file mode, refusal to overwrite, unchanged adapter authority/body/Response, no fallback/rotation/retry, and the unchanged sanitized error contract. The parity test also observes real installed-SDK output for GPT-6 Luna / Low and checks both paths' complete bodies and headers.

CLI typecheck passed. Root validation commands:

```sh
bun run lint packages/opencode/src/kilocode/provider/codex-diagnostic.ts packages/opencode/src/kilocode/provider/codex-profile.ts packages/opencode/test/kilocode/provider/codex-diagnostic.test.ts packages/opencode/test/kilocode/provider/codex-request-contract.test.ts
bun node_modules/.bin/prettier --check packages/opencode/src/kilocode/provider/codex-diagnostic.ts packages/opencode/src/kilocode/provider/codex-profile.ts packages/opencode/test/kilocode/provider/codex-diagnostic.test.ts packages/opencode/test/kilocode/provider/codex-request-contract.test.ts
bun run script/check-opencode-annotations.ts --worktree
bun run script/check-md-table-padding.ts
git diff --check
```

Targeted lint passed with 0 errors and 11 existing fixture-adapter assertion warnings, all in the pre-existing contract test; the new diagnostic source and test have no lint warnings. Formatting, annotation guard (no shared upstream source changes), Markdown table guard, and `git diff --check` passed. Results are recorded in `tmp/m12-http400-diagnostic/`. No dependencies, lockfile, live accounts, operator credential stores or databases, or earlier VSIX snapshots were changed. No live inference, OAuth operation, VSIX build/install, or push was performed. The live HTTP 400 remains unresolved pending a reviewed diagnostic capture.
