# M12 profile-bound Codex request correction

Branch: `feat/provider-account-profiles`. Reviewed parent: `eb781966d6e804c12947fb8cf2280f1f3c96a0a5`. This is the bounded correction approved in `/home/saint/fix4.txt`, based on the preserved [diagnostic report](provider-account-http400-diagnosis.md). Entry state had two untracked diagnostic files and no tracked source changes. Final changes are committed together; no VSIX rebuild, live-account access/mutation, push, or unrelated correction is included.

## Root cause and correction

`LLM.run` deliberately omits legacy auth for a bound account. The shared preparer formerly recognized Codex only through legacy `auth.type`, so profile requests lost top-level instructions and placed the system prompt in developer input. The token estimator already treated those requests as OAuth, creating inconsistent preparation and estimation.

Derive a nonsecret `oauth` boolean from the already-resolved profile selection or existing legacy OAuth auth, before request preparation. Pass it into `LLMRequestPrep.prepare`, gated there to the OpenAI provider, and reuse it for token estimation. Profile `auth` stays undefined. No secrets or manufactured legacy auth records are passed to preparation, and no legacy auth fallback is introduced.

Before: legacy/profile JSON differed in instructions and input message placement. After: full serialized bodies match for the same supported GPT-5.4 model, ordinary/title/branch-name conversations, tools, multiturn tool history, and encrypted reasoning replay. Endpoint, POST method, identity headers, streaming, `store:false`, supported reasoning options, tool schemas, and omitted output cap remain correct. API-key requests retain the public Responses endpoint and leading developer message, with no top-level Codex instructions. Transport body pass-through and the known profile-only model-filter characterization remain unchanged.

## Exact files

| File | Change |
|---|---|
| `packages/opencode/src/session/llm.ts` | Compute and reuse effective OAuth context before preparation. |
| `packages/opencode/src/session/llm/request.ts` | Accept the nonsecret indicator and use existing Codex preparation. |
| `packages/opencode/test/kilocode/provider/codex-request-contract.test.ts` | Convert the reviewed divergence characterization to four full-body parity regressions; retain the separate filter and body-pass-through findings. Test API-key behavior and sanitized SDK rejection. |
| `packages/opencode/test/kilocode/qualification/normal-acquisition.test.ts` | Exercise real LLM/Provider/SDK/profile dispatch with successful synthetic SSE for normal, title, pre-resolved branch, and explicit-account utility contexts; observe real preparation/estimation and zero legacy auth reads. |
| `.changeset/profile-codex-request-parity.md` | CLI/extension patch release note. |
| `.kilo/plans/provider-account-http400-diagnosis.md` | Preserve the reviewed diagnostic evidence with a historical-context note. |
| `.kilo/plans/m12-codex-request-correction.md` | This corrective handoff. |

The production diff is restricted to the two requested shared files and has Kilo annotations. Credential persistence, binding/default semantics, refresh/dispatch, endpoint rewriting, WebSocket behavior, sanitization, UI, availability lifecycle, model filtering, and arbitrary request-option clamping are unchanged.

## Validation

Pinned Bun **1.4.2**, installed frozen dependencies and lockfile unchanged. Commands use `PATH=/tmp/kilo-corrective-bin:$PATH`.

From `packages/opencode/`:

```sh
bun test ./test/kilocode/provider/codex-request-contract.test.ts ./test/kilocode/provider/codex-profile.test.ts ./test/kilocode/provider/availability.test.ts ./test/kilocode/provider/utility-account.test.ts ./test/kilocode/provider/utility-authority-lifecycle.test.ts ./test/kilocode/codex-refresh-user-agent.test.ts ./test/kilocode/session-profile-error.test.ts ./test/kilocode/session-llm-request.test.ts ./test/kilocode/session/llm.test.ts ./test/kilocode/server/provider-auth-lifecycle.test.ts ./test/kilocode/server/provider-accounts-lifecycle.test.ts ./test/kilocode/server/provider-accounts-api.test.ts ./test/kilocode/server/provider-account-usage-api.test.ts
bun test ./test/kilocode/qualification/ ./test/kilocode/session-authority-qualification.test.ts
bun test ./test/kilocode/session-authority-qualification.test.ts
bun run typecheck
```

Results:

- Focused request/LLM/utility/Provider Account suites: **64 passed / 0 failed**, 586 assertions, 13 files.
- Aggregate qualification: **63 passed / 1 failed**, 1,074 assertions, 22 files. The sole failure remains `session provider authority qualification > traces hostile provider errors through real session HTTP, messages, events, replay, and export`, line 517, expecting the synthetic A bearer in an empty upstream record. This is the same documented frozen-baseline aggregate failure, not a new parity regression. No expectations in that qualification test changed.
- Isolated authority: **5 passed / 0 failed**, 93 assertions.
- CLI typecheck: **pass**.

From `packages/core/`:

```sh
bun test test/kilocode/provider-account-profiles.test.ts test/kilocode/provider-profile-dispatch.test.ts test/kilocode/provider-profile-refresh.test.ts test/kilocode/provider-profile-qualification.test.ts test/kilocode/provider-profile-admission-qualification.test.ts test/kilocode/session-binding.test.ts
```

Result: **22 passed / 0 failed**, 216 assertions. Existing exact-profile, refresh, deletion, default isolation, no rotation/fallback, and persisted binding authority checks remain intact.

Negative control: extract the reviewed parent with `git archive eb781966d6e804c12947fb8cf2280f1f3c96a0a5 packages/opencode package.json bun.lock tsconfig.json` into ignored `node_modules/.cache/m12-codex-request-baseline`, retain the same installed dependencies/unchanged companion packages, and run the new request-contract file against that source. Result: **2 passed / 4 failed**; all four parity cases fail because profile instructions are absent, while the unchanged filter/body-pass-through characterizations pass. This proves the new parity expectations detect the original defect. The actual LLM integration also confirms profile preparation receives `auth:undefined`, `oauth:true`; estimator system content equals the wire instructions exactly once; a changed default does not replace bound A, and explicit utility B uses B. Synthetic SSE produces text deltas without provider-error events.

From root:

```sh
bun run lint packages/opencode/src/session/llm.ts packages/opencode/src/session/llm/request.ts packages/opencode/test/kilocode/provider/codex-request-contract.test.ts packages/opencode/test/kilocode/qualification/normal-acquisition.test.ts
bun node_modules/.bin/prettier --check packages/opencode/src/session/llm.ts packages/opencode/src/session/llm/request.ts packages/opencode/test/kilocode/provider/codex-request-contract.test.ts packages/opencode/test/kilocode/qualification/normal-acquisition.test.ts
bun run script/check-opencode-annotations.ts --worktree
bun run script/check-opencode-promise-facades.ts
bun run script/check-md-table-padding.ts
git diff --check
```

Targeted lint: **0 errors / 18 warnings**, comprising existing unused type imports and fixture/adapter type assertions. Formatting, shared annotations, promise-facade guard, markdown tables, and whitespace checks pass. No warnings were suppressed. Local-server suites use approved sandbox escalation; no live upstream request is made. Logs are ignored `tmp/m12-codex-parity-{focused,qualification,authority-isolated,core,typecheck,lint,baseline}.log` files.

## Review boundary and remaining issues

Stop after one corrective commit for human review. The separate profile-only OAuth model-filter issue remains tracked in the diagnostic report and its characterization test. The pre-existing aggregate qualification failure remains reported. Neither this correction nor synthetic streaming success proves that the operator's real OAuth HTTP 400 is resolved; that requires operator-controlled live inference after review. No credential authority, fallback, rotation, or implicit selection semantics changed.
