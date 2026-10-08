# M12 Provider Account HTTP 400 diagnostic checkpoint

> Historical diagnostic evidence at `eb781966d6e804c12947fb8cf2280f1f3c96a0a5`, before the approved correction. See [the corrective checkpoint](m12-codex-request-correction.md) for current behavior and validation. The request-divergence characterization was subsequently converted to parity regression assertions; the model-filter and body-pass-through findings remain unchanged.

Source: `Shardbyte/kilocode`, `feat/provider-account-profiles`, HEAD `eb781966d6e804c12947fb8cf2280f1f3c96a0a5`. The checkout was clean on entry. This checkpoint adds only this report and `packages/opencode/test/kilocode/provider/codex-request-contract.test.ts`. No production source, credential data, dependency versions, lockfile, session behavior, or packaged artifact changed. No live inference, OAuth flow, account mutation, VSIX rebuild, commit, or push was performed.

## Confirmed findings

**Profile-bound inference loses the Codex request-preparation context.** `LLM.run` resolves the persisted OpenAI binding and uses its exact `profileID` for language acquisition, while deliberately passing `auth: undefined` to request preparation (`src/session/llm.ts:165–177`). This is correct for credential isolation. However, `LLMRequestPrep.prepare` recognizes OpenAI OAuth exclusively through `input.auth?.type === "oauth"` (`src/session/llm/request.ts:71`). Consequently its instruction construction and system-message omission branches (`:121`, `:127`) do not execute for a profile. The broader OAuth predicate in `LLM.run:189` executes after preparation and only affects token estimation; it cannot repair the prepared payload.

The new deterministic test runs the actual shared preparer, actual Codex header/parameter hooks, actual ProviderTransform middleware, actual installed OpenAI Responses SDK, and actual legacy/profile fetch adapters against an in-process synthetic transport. No request reaches OpenAI. For the same supported model and synthetic conversation:

| Wire property | Legacy OAuth | Profile OAuth |
|---|---|---|
| Endpoint | Official Codex responses endpoint | Same |
| Method | POST | Same |
| Account/bearer authority | Synthetic selected account | Same selected account |
| Complete HTTP headers | Recorded in memory | Byte-equivalent values in this fixture |
| Model | gpt-5.4 | Same |
| stream | true | true |
| store | false | false |
| max_output_tokens | Absent | Absent |
| instructions | String | Absent |
| input role sequence | user | developer, user |
| Other serialized options | Compared by test | Equal |

**These are not equivalent Codex requests.** Missing top-level instructions and relocated system content are established before transmission. JSON and generic Responses serialization are valid; an omitted instructions field alone is not proof of an invalid public Responses API request. Compatibility with the private ChatGPT Codex service is the concern. The official [Codex client construction](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) sends top-level instructions, `store:false`, and `stream:true`; its [request definitions](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs) carry the instructions field through HTTP and WebSocket representations. This supports the parity concern but does **not** establish the operator's exact upstream rejection reason.

**Profile-only model catalogs skip the existing OAuth compatibility filter.** `Provider` passes only legacy `auth.get(providerID)` into the plugin model hook (`src/provider/provider.ts:1525–1528`). `CodexAuthPlugin.provider.models` returns the entire catalog without OAuth auth (`src/plugin/openai/codex.ts:466`), before its supported-model and pro-mode filtering. The test demonstrates that legacy OAuth retains gpt-5.4 while profile-only context also retains gpt-4.1, gpt-5.6, and gpt-5.5-pro. This can expose incompatible choices, but the failing live model/variant was not supplied. Actual account entitlement also remains unknown.

## Full path and comparison

1. **Binding acquisition:** `Session.binding` and `codex-profile.resolveBinding` consume persisted authority. Missing, unbound, disabled-profile, and unsupported-auth slots fail locally. Utility resolution uses explicit session/account context. Defaults are not request-time account selectors.
2. **Model/metadata:** `Provider.getLanguage` keys its language cache by provider/model/profile; it suppresses environment credential resolution for profile mode. OpenAI uses the Responses SDK. Profile-only metadata differs because the legacy-auth model hook is not applied.
3. **SDK configuration:** `Provider.resolveSDK` (`src/provider/provider.ts:1835`) installs the dummy SDK key and the exact-profile fetch. Conflicting provider/model API key, base URL, or authorization overrides fail locally. A configured fetch is replaced, preventing inherited transport from capturing profile credentials.
4. **Fetch injection:** `src/kilocode/provider/codex-profile.ts:151` injects account refresh and transactional dispatch. The legacy loader is `src/plugin/openai/codex.ts:513`.
5. **URL rewrite:** `makeFetch:109` permits only the exact official HTTPS Responses or Codex endpoint, without query/hash/userinfo. Public Responses rewrites to Codex. Legacy also rewrites chat/completions paths; profile mode rejects them. The tested stock Responses route is equivalent and does not use chat/completions.
6. **Method/headers:** SDK produces POST JSON; both adapters preserve it for URL-plus-init SDK calls. Shared Codex hooks provide originator, User-Agent, and session-id for both modes. Profile dispatch overwrites bearer/account identity, clears inherited residency, derives residency from its exact token on rewrite, strips the internal title marker, and rejects redirects. New assertions prove inherited legacy identity cannot survive. Neither tested HTTP route adds an OpenAI-Beta header; no mode-specific missing-header defect is established.
7. **Body:** shared preparation and ProviderTransform construct options/messages; the OpenAI SDK serializes them. Default `store:false` is already correct. Shared Codex chat.params removes max-output-token caps. The confirmed instructions divergence originates before either fetch wrapper. Neither wrapper normalizes bodies. A test confirms profile transport preserves inherited `store:true`, temperature, and max_output_tokens verbatim; whether the operator configured such options is unknown.
8. **Refresh:** `codex-profile.refresh:55` uses `withRefresh(id, ...)`, reloads only that credential, refreshes only if missing/expired access, calls the official OAuth token endpoint with redirect protection and timeout, verifies remote/account identity, and writes a revision-checked replacement. Legacy uses `refreshCodexAuth`. Refresh success does not establish model entitlement or inference-body validity.
9. **Dispatch:** `ProviderAccountProfiles.dispatch` (`packages/core/src/kilocode/provider-account-profiles.ts:334`) transactionally checks the exact account/secret and initiates the transport with that current revision. The response promise is awaited outside dispatch handoff. Missing/deleted accounts fail closed. Existing tests cover default changes, concurrency, revision updates, and no account rotation/fallback.
10. **Response handling:** SDK converts HTTP rejection into an API error. `MessageV2.fromError` classifies it; `KiloSessionProcessor.profileError` (`src/kilocode/session/processor.ts:52`) removes sensitive upstream messages, bodies, and headers while retaining status/retry classification and approved retry headers. A synthetic real SDK 400 produces the user's sanitized error contract; the new test verifies private upstream text and token are absent.

**Transport distinction:** legacy optionally uses `OpenAIWebSocketPool.createWebSocketFetch`; profile fetch always uses HTTP, overriding inherited fetch hooks. HTTP SSE is the established legacy default too. WebSocket pool restoration would require profile/account-scoped isolation, not reuse of a legacy session pool. No evidence currently supports changing transport to fix this 400.

## Bounded diagnostics design for review

No permanent logger or runtime hook was installed. Proposed mechanism is a temporary, default-off diagnostic lease at the exact-profile request boundary, with expiry and at most three request/result records per explicitly selected operation. No network export or general log sink. Share only the resulting allowlisted report, never transport objects.

- Correlation: a random operation label and an HMAC-SHA256 label over the profile ID using a random per-lease key. Do not persist the key, actual profile ID, session ID, account ID, or any credentials. Plain deterministic hashing of identifiers is insufficient.
- Request: catalog-validated provider/model ID, route enum (`public-responses`, `codex-responses`, `blocked`), method enum, transport enum; booleans for authorization/account/originator/User-Agent/session/content-type/beta header presence. No header values. Token source/account consistency may be reported only as an internal boolean.
- Body: inspect the SDK's serialized JSON only in memory. Project known top-level fields to absent/null/boolean/string/array/object/number types; include `instructions` presence/nonempty, `store` and `stream` booleans, known reasoning-effort enum, and input role enums/counts. Never include prompt/content, nested arbitrary metadata, tools/schema content, full bodies, lengths of private text, unknown field names, or arbitrary values. Unknown fields contribute only a count. Impose input byte/depth limits and report `uninspected` if exceeded; never consume a Request body to inspect it.
- Result: HTTP status, approved retry booleans, and a closed code/category enum. For an error JSON response, inspect at most 4 KiB from a clone with a short deadline, without consuming the caller's response. Abort/cancel the diagnostic reader on overflow/time limit. Classify only exact known codes or fixed reviewed literal signatures (for example, a missing-instructions signature); discard raw bytes immediately. Unknown code/type/message becomes `unknown`, never an echoed string. SSE/WebSocket errors, if later instrumented, need the same bounded projection. Preserve original response and existing user-facing sanitization.
- Categories: authorization (401/403 or approved token/account code), missing-instructions/payload, unsupported-model, unsupported-option, missing-header (local presence check), transport failure, service rejection, unknown. Status 400 alone cannot distinguish these. Credential freshness/usage success is supporting context, not an authorization verdict.
- Safety tests before any runtime installation: poison every credential/header/prompt/error field; unknown keys/codes and identifier collisions; oversized/malformed JSON; reader timeout/cancellation; streamed errors; unchanged caller response; maximum records/lease expiry; identical user-facing error. Assert outputs are closed-schema metadata and contain none of the poison values.

Controlled upstream validation is still needed to attribute the **live** 400. After review, one operator-authorized profile-only turn can capture only that projection and identify selected model/variant and rejection category. No reauthentication, account removal, account switching, rotation, fallback, or full-payload logging is necessary. If the category remains unknown, report that uncertainty rather than expose raw errors.

## Proposed smallest correction — not implemented

Derive effective OpenAI OAuth request context from the already-resolved binding/utility selection before request preparation. Pass a nonsecret explicit auth-mode/context hint to `LLMRequestPrep.prepare`, so profile-bound ChatGPT OAuth uses the same instructions and message placement as legacy OAuth. Keep `auth` undefined for profile requests; do not pass a profile secret, manufacture a legacy OAuth record, read legacy auth, or alter refresh/dispatch. Use the same effective predicate for preparation and estimation. This should need a narrow hook in `src/session/llm.ts` and `src/session/llm/request.ts`, with any additive policy in Kilo-owned code.

After architecture approval, convert the characterization test to body parity assertions and add actual `LLM.run` profile-only/legacy/API-key coverage, including title/utility requests, tools/multiturn/reasoning replay, fresh binding authority, and no legacy auth read. API-key sessions must retain their existing generic system-message behavior. Treat profile model compatibility as a separate contextual admission change: applying a global OAuth filter merely because any account exists could incorrectly remove API-key models in mixed environments. No model filter, transport, request-option clamp, or other inference correction has been applied here.

## Validation

Bun 1.4.2 from the previously validated pinned cache; existing frozen dependencies/lockfile retained. Commands use `PATH=/tmp/kilo-corrective-bin:$PATH`. From `packages/opencode/`:

```sh
bun test ./test/kilocode/provider/codex-request-contract.test.ts ./test/kilocode/provider/codex-profile.test.ts ./test/kilocode/codex-refresh-user-agent.test.ts ./test/kilocode/session-profile-error.test.ts ./test/kilocode/session-llm-request.test.ts
bun test ./test/kilocode/qualification/normal-acquisition.test.ts ./test/kilocode/session-authority-qualification.test.ts
bun run typecheck
```

Results: **33 passed / 0 failed**, 156 assertions; **7 passed / 0 failed**, 113 assertions; CLI typecheck **passes**. The new file contributes three characterization tests and 48 assertions. From `packages/core/`:

```sh
bun test test/kilocode/provider-profile-dispatch.test.ts test/kilocode/provider-profile-refresh.test.ts test/kilocode/session-binding.test.ts
```

Result: **8 passed / 0 failed**, 55 assertions. Total focused coverage: **48 passed / 0 failed**. From root:

```sh
bun run lint packages/opencode/test/kilocode/provider/codex-request-contract.test.ts
bun node_modules/.bin/prettier --check packages/opencode/test/kilocode/provider/codex-request-contract.test.ts
bun run script/check-md-table-padding.ts
 git diff --check
```

Targeted lint: **0 errors, 9 warnings** for fixture/plugin adapter type assertions; warnings remain explicit. Typecheck catches fixture type mismatches; initial mismatches were fixed. Initial sandbox HTTP tests failed to listen (`EPERM`); the local-server rerun with required access passes. The final new tests themselves need no external network. Logs: `tmp/m12-http400-tests.log`, `tmp/m12-http400-authority.log`, `tmp/m12-http400-core.log`, `tmp/m12-http400-lint.log`.

The known broad aggregate qualification failure from the prior checkpoint is not claimed fixed or green; this run uses focused suites, where authority passes. Its earlier frozen-baseline reproduction remains documented in `provider-account-availability-checkpoint.md`.

Stop boundary: the prompt explicitly requires “Stop for human architecture review before making an inference-path correction.” Production behavior and reviewed HEAD remain unchanged. The live OAuth inference HTTP 400 is unresolved pending controlled attribution and review.
