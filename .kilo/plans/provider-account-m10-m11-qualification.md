# Provider Account Profiles M10-M11 Qualification

## Baseline

- QUALIFICATION_BASELINE: `2547dd8f908a8dfcd16d0d3396b46933720f52db`.
- Parent: `f2ad10f5c6c67052940bf19f14ceacf28add6b9d`.
- Branch: `feat/provider-account-profiles`.
- Baseline was clean, unstaged, and synchronized with origin before qualification.
- Cleanup subject and one-file, one-import deletion were verified.
- All accepted checkpoints remain ancestors; no history rewrite is authorized.
- Bun: 1.4.2 (`744846f84`). Java: Eclipse Temurin 21+35-LTS.
- Linux x86_64, kernel 6.12. Source filesystem: ext4; `/tmp`: tmpfs.
- Default process umask: 0007. Git `safe.bareRepository=explicit` unchanged.

## Evidence Rules

Only executed evidence qualifies a requirement. An API-shaped fixture is protocol evidence, not execution of a historical client binary. In-process SQLite evidence is not cross-process evidence. Inspection is explicitly distinguished from execution. Synthetic secrets are identified by marker names; their values must not appear in this report.

Qualification is in progress. A passing subset is not a passing complete campaign.

## Executed Evidence Ledger

All Bun commands use `PATH=/tmp/kilo/bun-tooling/node_modules/.bin:$PATH` and Bun 1.4.2. Backend test preload uses isolated in-memory SQLite; core process fixtures use real disk databases. These must not be conflated.

| ID | Command | Directory | Result | Topology / Boundary |
|---|---|---|---|---|
| C1 | `bun test test/credential.test.ts test/event.test.ts test/kilocode-provider-usage-codex.test.ts test/kilocode/provider-account-profiles.test.ts test/kilocode/provider-profile-dispatch.test.ts test/kilocode/provider-profile-refresh.test.ts test/kilocode/session-binding.test.ts test/database-migration.test.ts test/kilocode/provider-profile-qualification.test.ts test/kilocode/qualification-migration.test.ts` | `packages/core` | 117 passed, 490 assertions | Real SQLite; separate Bun workers for cross-process cases |
| C2 | `bun test test/kilocode/provider-account-profiles.test.ts test/kilocode/provider-profile-dispatch.test.ts test/kilocode/provider-profile-refresh.test.ts test/kilocode/provider-profile-qualification.test.ts test/kilocode/session-binding.test.ts` | `packages/core` | 21 passed, 191 assertions | Cross-process duplicate creation, refresh/removal, turn/exclusive locks, independent stores |
| S1 | `bun test test/kilocode/session-authority-qualification.test.ts` | `packages/opencode` | 3 passed, 24 assertions | Real Session/profile services; deterministic Deferred turn barrier; in-process SQLite |
| G1 | `bun run script/generate.ts` twice, comparing `git hash-object` for OpenAPI, generated v2 SDK/types and both CLI reference artifacts | Root | Identical hashes; no generated diff | Separate generator invocations; no manually patched artifacts |
| G2 | `bun run typecheck && bun test` | `packages/sdk/js` | Passed; 23 tests, 37 assertions | Generated client request serialization and existing account APIs |
| V1 | `bun run compile` | `packages/kilo-vscode` | Passed | Extension host, CLI smoke/generation and webview production bundles |
| V2 | `bun run test:unit` | `packages/kilo-vscode` | 6,705 passed, 24 skipped, 40,553 assertions | One Bun runner with existing shared VS Code shim |
| J1 | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem LD_LIBRARY_PATH=/tmp/kilo/awt-runtime/usr/lib/x86_64-linux-gnu xvfb-run -a ./gradlew test` | `packages/kilo-jetbrains` | 5,520 tests, zero failures/skips | Java 21 JVM tests under Xvfb; temporary XInput/XTest libraries |
| T1 | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem bun run typecheck --concurrency=1` | Root | 30/30 tasks successful | Serial Turbo package checks; 18 cached results |
| A1 | `bun run script/check-opencode-annotations.ts --worktree` | Root | Passed, no shared upstream source changes at this run | Worktree scope guard |
| A2 | `bun run script/check-opencode-promise-facades.ts` | Root | Passed, six classified runtime sites, 179 test references | No runtime facade drift at this run |
| A3 | `bun run script/check-workflows.ts` | Root | Passed, 33 workflows | No workflow changes |
| A4 | `bun run script/check-md-table-padding.ts` | Root | Passed, 371 files | Markdown guard |

### Deterministic Race Witnesses

- Core duplicate-remote creation: two Bun workers share one SQLite file; explicit release yields exactly one CREATED and one DUPLICATE.
- Core refresh/removal: a separate Bun waiter reports real lock contention, deletion commits, stdin barriers release the owner/waiter, and the waiter returns AccountUnavailableError.
- Independent stores: two Bun workers use different disk databases and the same account label. IDs differ; B cannot read or dispatch A's ID; foreign dispatch callback is never called. B can dispatch its own credential and A remains unchanged.
- Revision ordering: reauthentication wins revision 0, stale refresh fails; credential CAS then wins revision 1, stale reauthentication fails. Remote identity replacement also fails.
- Session admission: a Deferred barrier holds a real Session turn; concurrent binding assignment returns TurnActiveError. This is in-process service evidence, not cross-process route evidence.

### Historical Data Transitions

Executed archived source modules in separate Bun processes against disk SQLite, with current dependencies symlinked into isolated archive trees. These are not released-binary tests.

| Checkpoint | Exact SHA | Historical Producer -> Final Reader | Final Producer -> Historical Reader |
|---|---|---|---|
| M1 | `7c264af09b44d6af218119de464effca1428b215` | Profile, credential revision and default read successfully; bindings predate this version | Same profile/revision/default accessible; no binding implementation |
| M2-M6 | `72732985186da5a19c8febcb5bef3543541128b8` | Profile/revision/default/binding read successfully | Same persisted fields read successfully |
| M7 | `b20e2688f036703317cf87af35c6a32a2f3d9cd0` | Profile/revision/default/binding read successfully | Same persisted fields read successfully |
| M8-M9 | `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12` | Profile/revision/default/binding read successfully | Same persisted fields read successfully |
| M9.5 | `f2ad10f5c6c67052940bf19f14ceacf28add6b9d` | Profile/revision/default/binding read successfully | Same persisted fields read successfully |

Bindings were produced with historical SessionBinding serialization and official SessionTable schemas, not full historical HTTP assignment routes.

The actual pre-profile Credential service at `76bcfd40be616a72f4697b3041565f322245b462` was run against final-produced storage plus isolated stale auth.json. It observed the legacy browser credential, not the newer profile authority. This is an empirical downgrade hazard, not a promise of transparent rollback. Full historical binaries and app flows remain unexecuted.

## Filesystem And Platform Evidence

From `packages/kilo-vscode`, with `PATH=/tmp/kilo/bun-tooling/node_modules/.bin:$PATH`:

```sh
TMPDIR=/tmp bun test tests/unit/local-diff.test.ts tests/unit/pr-suggestion-actions.test.ts tests/unit/git-transfer.test.ts
TMPDIR=/home/saint/projects/research/kilocode/.kilo/qualification-tmp bun test tests/unit/local-diff.test.ts tests/unit/pr-suggestion-actions.test.ts tests/unit/git-transfer.test.ts
umask 0022 && TMPDIR=/tmp bun test tests/unit/git-transfer.test.ts
```

- tmpfs run: 134 passed, 1,052 assertions, zero failures.
- ext4 run: 134 passed, 1,052 assertions, zero failures.
- alternate umask run: 20 passed, 78 assertions, zero failures.
- Topology: one Bun runner per invocation with real Git subprocesses and filesystem fixtures. No timing sleeps are used as race proof.
- Linux executed. Windows and macOS unavailable locally; not qualified by these results.
- `gh run list --repo Shardbyte/kilocode --branch feat/provider-account-profiles --limit 10 --json databaseId,headSha,name,status,conclusion,url` returned no hosted runs. Existing workflow platform declarations are not evidence of a passing run for this baseline.

## Storage Boundary

Profile credentials reside in backend-local SQLite secret storage. SQLite database, WAL, copied databases, and backups must be treated as credential-bearing artifacts. Utility authority metadata is not an additional credential store. This milestone does not add database encryption or promise that a copied database is safe to publish.

## Closure Campaign Regression Ledger

These entries supersede earlier counts for the same commands. Earlier entries remain checkpoint evidence, not proof that later edits passed. Commands use the Bun PATH stated above and run in the named package. All transport credentials and failure bodies are synthetic.

| Area | Exact command | Result |
|---|---|---|
| Core | `bun test --timeout 60000 test/credential.test.ts test/event.test.ts test/kilocode-provider-usage-codex.test.ts test/kilocode/provider-account-profiles.test.ts test/kilocode/provider-profile-dispatch.test.ts test/kilocode/provider-profile-refresh.test.ts test/kilocode/session-binding.test.ts test/database-migration.test.ts test/kilocode/provider-profile-qualification.test.ts test/kilocode/qualification-migration.test.ts test/kilocode/provider-profile-history-qualification.test.ts` | PASS: 118 tests, 565 assertions, 11 files. Initial default-timeout run failed when the archive subprocess test exceeded 5 seconds; rerun used an explicit 60-second limit. |
| Core | `bun run typecheck` | PASS. |
| OpenCode provider | `bun test test/provider` | PASS: 612 tests, 1,231 assertions, 9 files. |
| OpenCode LLM | `bun test test/session/llm.test.ts test/session/llm-native.test.ts test/session/llm-native-recorded.test.ts` | PASS: 52 passed, 1 skipped, 177 assertions, 3 files. The skipped case is not executed evidence. |
| Real native positive control | `KILO_EXPERIMENTAL_PROVIDER_PROFILES=1 KILO_RECORDED_SCENARIO=anthropic-api-key bun test test/session/llm-native-recorded.test.ts` | PASS: 1 test, 8 assertions, 1 file. The native runtime flag is enabled; real LLM and RequestExecutor execute a compatible non-profile Anthropic tool loop through recorded HTTP transport and produce final text. This is real native execution with cassette HTTP, not the separate dispatch-stub control. |
| OpenCode Codex | `bun test test/plugin/codex.test.ts test/kilocode/codex-auth-refresh.test.ts test/kilocode/codex-refresh-user-agent.test.ts test/kilocode/provider/codex-oauth.test.ts test/kilocode/provider/codex-profile.test.ts` | PASS: 71 tests, 182 assertions, 5 files. |
| OpenCode session/task | `bun test test/kilocode/session-resume-integration.test.ts test/tool/task.test.ts` | PASS: 80 tests, 409 assertions, 2 files. |
| OpenCode additional task regression | `bun test test/kilocode/session-resume.test.ts test/tool/task.test.ts test/kilocode/tool-task-model.test.ts test/kilocode/task-nesting.test.ts test/permission-task.test.ts` | FAIL: 172 passed, 1 failed, 618 assertions, 5 files. `treats a missing ancestor row as the root` throws `NotFoundError`. |
| Task failure attribution | `bun test test/kilocode/task-nesting.test.ts` in current sources and an archive of baseline `2547dd8f908a8dfcd16d0d3396b46933720f52db` | FAIL identically: 9 passed, 1 failed, 29 assertions in each. Relevant test and production source match HEAD. Existing dependencies were linked into archived sources; this is not a released-binary result. No unrelated corrective edit was made. |
| SDK | `bun run typecheck`; `bun test` | PASS: typecheck; 23 tests, 37 assertions, 6 files. |
| Root generator | `bun run script/generate.ts` twice | PASS. SHA-256 fingerprints matched for OpenAPI, generated v2 SDK types/methods, CLI reference, and CLI commands table; no generated worktree change. |
| VS Code | `bun run compile`; `bun run test:unit`; `bun run lint`; `bun run knip`; `bun run check-kilocode-change`; `bun run typecheck` | PASS: unit suite 6,705 passed, 24 skipped, 0 failed, 40,553 assertions, 515 files. Compile emitted a Vite large-chunk warning. |
| JetBrains initial final attempt | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem LD_LIBRARY_PATH=/tmp/kilo/awt-runtime/usr/lib/x86_64-linux-gnu xvfb-run -a ./gradlew test` | FAIL: backend reached 1,140 tests, 1 failure in `KiloBackendWorkspaceTest > workspace warnings are loaded into Ready()` (10-second teardown timeout). This attempt is not erased by a later pass. |
| JetBrains isolated retry | Same Java/library/Xvfb environment, `./gradlew :backend:test --tests 'ai.kilocode.backend.workspace.KiloBackendWorkspaceTest.workspace warnings are loaded into Ready' --rerun-tasks` | PASS. Full class XML: 28 tests, no failures/errors/skips. |
| JetBrains full forced retry | Same Java/library/Xvfb environment, `./gradlew test --rerun-tasks` | PASS: 5,521 tests in 361 XML suites, no failures/errors/skips. Shared: 13; frontend: 4,368; backend: 1,140. Timeout did not recur; no timeout workaround or source correction was applied. |
| JetBrains | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem ./gradlew typecheck` | PASS. |
| Dispatch/refresh/usage logs | `bun test test/kilocode/qualification/usage-security-api.test.ts test/kilocode/qualification/usage-security-cache.test.ts` in `packages/opencode` | PASS: 3 tests, 45 assertions, 2 files. Production logger initialized at DEBUG with stderr capture and an asserted positive logger-output control; actual usage API exercises profile dispatch exception, expired-token refresh exception, and usage HTTP 503. All five forbidden marker names absent from captured output and returned DTOs. This does not cover processor or utility-generation logs. |
| Utility closure | `bun test test/kilocode/qualification/utility-inference.test.ts` in `packages/opencode` | PASS: 14 tests, 111 assertions, 1 file. Actual Provider SDK cache, synthetic OAuth refresh transport, automatic retry, common source resolver, real prepare/generate boundary with a narrow model-availability fault seam, and actual commit logger are covered. |
| Root lint after interruption, initial attempt | `bun run lint` | FAIL: `tsgolint headless` was killed with SIGKILL while other package regressions ran. Kernel evidence subsequently established global OOM (see below); this failed attempt is retained. |
| Root lint bounded retry | `GOMAXPROCS=2 bun run lint --threads=2` | PASS: latest corrective integration rerun 11,065 warnings, 0 errors across 6,159 files. Diagnostics were not disabled; concurrency was bounded. |
| Root typecheck | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem GOMAXPROCS=2 bun run typecheck --concurrency=2` | PASS: final integration 30/30 tasks, 29 cache hits. Covers all 33 packages in scope that declare a typecheck task; 30 tasks exist. |

### SIGKILL Attribution

`journalctl -k --since '2026-10-06 00:39:00' --no-pager --grep 'Killed process|oom-kill|Out of memory|tsgolint'` established kernel global OOM kills on 2026-10-06: `tsgo` PID 576144 at 00:45:00 UTC (anonymous RSS 5,884,580 kB), then `tsgolint` PID 576493 at 00:45:14 UTC (anonymous RSS 10,837,400 kB). Both records show `CONSTRAINT_NONE` / `global_oom`, not an argument-limit error or a diagnosed cgroup limit. Current `/proc/meminfo` reports 24,546,416 kB RAM and zero swap; the later available-memory snapshot does not represent the earlier peak. `getconf ARG_MAX` is 2,097,152 bytes. Tool output line caps and timeouts are not memory limits. No machine settings, swap, or cgroup configuration were changed. Full-scope retries constrain concurrency, not checks or diagnostics.

### Utility Closure Evidence

- PASS: actual SDK cache sequence A/B/A, expire A through credential CAS, invoke the actual OAuth refresh endpoint through synthetic transport, observe rotated A bearer, B, delete A, reject any new A transport, acquire the cached B again and dispatch with unchanged B bearer/account headers. CAS expiration is setup, not falsely described as the refresh itself.
- PASS: actual `generateText` retry after a 429 with a first-attempt readiness signal and release gate. Before retry, default becomes B and env/legacy credentials change. Every actual transport attempt remains A; no sleep is used to prove ordering.
- PASS: common real resolver with a valid current session, real stored sessions created under different directory/project contexts, nonexistent/synthetic IDs, and deleted source. Wrong provenance fails admission.
- PASS: actual commit prepare/generate functions submit the same captured model identity. The existing `CommitMessageRuntime.model` seam returns the real preparation model, then simulates that exact identity becoming unavailable; generation fails with static `model-unavailable` and never invokes the generation seam. This tests boundary behavior under model unavailability, not dynamic model-catalog reload.
- PASS: commit generation's actual logger emits its static `generation failed` line while the injected generation exception contains all five forbidden markers. Captured output and returned error contain none. Runtime selection/resolve/generation methods are fault-injection seams in this logger test; it is not separate proof of SDK account dispatch (covered by the actual SDK tests).
- PASS: real non-profile native positive control uses Anthropic cassette HTTP with native enabled and profiles enabled, as recorded above. The separate profile-negative dispatch stub is not misrepresented as a complete native implementation.

## Provenance Boundaries

Provider/auth/internal errors are not transcript content. Credential-bearing provider diagnostics must not be published or persisted merely because an SDK error includes their text, response body, request headers, or nested cause. Qualification must drive that error through processing and inspect the resulting state and events.

User/model text is a different boundary: normal transcript persistence and export intentionally preserve content. An arbitrary user string must not be removed solely because it resembles a synthetic credential marker. The earlier four-test HTTP/session/event/export qualification used empty transcripts and did not establish hostile-provider-error sanitization. Its non-leak assertions are valid only for the exercised metadata/binding surfaces.

### Reproduced Hostile Error (Before Correction)

The initial real-session failure test used an actual local upstream HTTP 401, backend HTTP listener, SDK prompt, and session processor. Its raw provider error body reached the client prompt error, persisted assistant error, live events, and JSON export. Assistant parts were empty; session metadata and the inspected durable `session.updated` replay did not include the body. User text was intentionally non-empty and preserved independently.

This is FAIL evidence for raw provider-originated diagnostic propagation, not a secrecy PASS. That first execution did not configure the markers as actual stored profile credentials; the follow-up ties the synthetic provider body to trusted configured credential values before selecting the minimal frozen-invariant correction. A passing test that asserts propagation is not a passing security requirement.

### Interrupted Correction Reconciliation

The interrupted credential-string replacement was rejected as inadequate: it removed only currently known token strings and still allowed arbitrary provider-originated secret diagnostics. It also introduced a `process.env` temporal-dead-zone failure in compaction; the exact compaction test reproduced it. The replacement/credential-loading code has been removed, and the real session and compaction tests pass with static profile error DTOs instead.

Independent review identified an additional offline-handler path that can publish/log raw provider messages, and a retry-classification concern when original message/body/header data is stripped before internal policy decisions. Those paths require correction and focused empirical regressions before the terminal 401 result is generalized to session failure handling. The terminal 401 result alone is not global error/log qualification.

### Final Security Closure

The above offline bypass is corrected: profile-backed offline status, question, and logs now use a static message while original errors remain internal for connectivity detection. The sanitizer derives retry eligibility from the original parsed error, retains context-overflow classification, and admits only syntactically validated numeric/HTTP-date retry headers. A further empirical regression found that sanitized nonretryable quota errors with HTTP 503 would be reclassified by the existing policy; the retry-only DTO now omits that status when terminal, while the persisted/client DTO retains it. No upstream retry policy was changed. Regression covers quota at 429 and 503, a body-classified transient 400, invalid headers, validated backoff, context overflow, and deterministic offline rejection.

| Required Surface | Status | Empirical Evidence / Limit |
|---|---|---|
| Hostile profile provider-error persistence | PASS | Actual profile access bearer reaches synthetic failing provider transport. Real session HTTP execution, prompt DTO, stored assistant error, HTTP messages/parts/info, live events, durable metadata replay and sanitized JSON export exclude provider/access/refresh/environment markers. Safe 401 and retry=false are retained. No full process-restart/resume-error campaign is claimed. |
| Message-content boundary | PASS | Non-empty user transcript intentionally contains the auth-content marker and is preserved in user parts/export. Assistant error/parts have independent provenance; no arbitrary user/model-text redactor was introduced. |
| Dispatch/refresh/usage logs | PASS | Real production logger capture, positive sink control and actual HTTP-handler failure paths exclude all five markers; 3 tests /45 assertions. |
| Utility generation logs | PASS | Actual commit logger and returned static DTO exclude all five markers from an injected generation exception; real SDK dispatch is separately tested. |
| Session processor terminal/offline logs | PASS | `session-error-logs.test.ts` spawns the actual session/helper tests with `KILO_PRINT_LOGS=1`, captures OS stdout/stderr, asserts terminal and offline logger controls and zero forbidden markers. Initial default-print attempt lacked the terminal control and was not counted as PASS. |
| PostHog completion telemetry | PASS | Existing `Client.capture` seam captures event names/properties. Real completion-metrics helper emits a positive control; hostile failed turn emits no completion event, and all captured failure-turn telemetry properties exclude the five markers. This is scoped sink evidence, not source-inspection-only proof. |
| Existing OTLP log/trace exporters | PASS | Loopback collector captures production `/v1/logs` and `/v1/traces` batches from a child running the actual hostile session HTTP test. Exporter/preload and runtime batches have separate positive controls; runtime batches exclude access/refresh/provider-error/environment markers. Intentional user transcript content is not treated as a forbidden secret. Other sinks/caller combinations remain unqualified. |
| A/B real SDK cache | PASS | Actual SDK instances and OAuth refresh transport cover A/B/A/refresh-A/B/delete-A/B with distinct bearer and remote account headers. A deletion fails closed and cached B remains unchanged. |
| Automatic retry non-substitution | PASS | Actual `generateText` retry, readiness/release barrier, default B mutation plus poisoned env/legacy credentials; every attempt remains A. No sleeps used as identity proof. |
| Real native non-profile positive control | PASS | Native flag and profiles enabled with real recorded Anthropic runtime/RequestExecutor tool loop; cassette replaces HTTP transport only. Profile-negative dispatch-stub evidence remains labeled separately. |
| Stale prepared model | PASS | Same prepared model reference becomes unavailable through existing model-availability fault seam; real prepare/generate boundary returns static unavailable without invoking generation or replacement selection. No model-catalog reload claim. |
| Source directory/project provenance | PASS | Common real resolver admits correct source and rejects actual stored sessions in wrong directory/project contexts, nonexistent/deleted sources and synthetic request IDs. No duplicated utility policy was added. |

### Final Combined Backend Command

Run from `packages/opencode/` with the stated Bun PATH:

```sh
bun test test/kilocode/session-authority-qualification.test.ts test/kilocode/session-profile-error.test.ts test/kilocode/session-error-logs.test.ts test/kilocode/session-processor-network-offline.test.ts test/kilocode/qualification/utility-inference.test.ts test/kilocode/provider/utility-authority-lifecycle.test.ts test/kilocode/qualification/usage-security-cache.test.ts test/kilocode/qualification/usage-security-api.test.ts test/kilocode/qualification/client-protocol.test.ts test/kilocode/qualification/cli-boundary.test.ts test/kilocode/provider/utility-account.test.ts test/kilocode/utility-runtime-authority.test.ts test/kilocode/enhance-prompt-authority.test.ts test/kilocode/commit-message-authority.test.ts test/kilocode/agent-generation-authority.test.ts test/kilocode/compaction-account-authority.test.ts test/kilocode/cli/utility-account.test.ts test/kilocode/branch-name.test.ts test/kilocode/session-title-generation.test.ts test/kilocode/memory/memory-ports.test.ts test/kilocode/memory/memory-integration.test.ts test/kilocode/qualification/adversarial-cases.test.ts test/kilocode/qualification/otlp-exporter-qualification.test.ts test/kilocode/task-profile-order.test.ts
```

PASS: latest corrective integration **105 tests, 663 assertions, 24 files**. This supersedes the earlier 97/586/21 checkpoint and includes the adversarial, OTLP and order-sensitive additions. Nested subprocess regressions additionally execute real session/helper and OpenAI tests; their assertions are not added to the parent count. `bun run typecheck` in `packages/opencode` and root typecheck pass with the final additions. Core 118/565, provider 612/1,231, LLM 52 passed/1 skipped/177, Codex 71/182, session/task 80/409, SDK 23/37, VS Code 6,705 passed/24 skipped/40,553, and JetBrains 5,521 across 361 suites were rerun after interruption. Counts and exact commands above retain the initial failures, including the independently reproduced baseline task-nesting failure.

An initial single-process aggregate invocation of the broader backend suites failed: `bun test test/provider test/session/llm.test.ts test/session/llm-native.test.ts test/session/llm-native-recorded.test.ts test/plugin/codex.test.ts test/kilocode/codex-auth-refresh.test.ts test/kilocode/codex-refresh-user-agent.test.ts test/kilocode/provider/codex-oauth.test.ts test/kilocode/provider/codex-profile.test.ts test/kilocode/session-resume-integration.test.ts test/tool/task.test.ts` produced **808 passed, 1 skipped, 7 failed, 1,963 assertions, 19 files**. Failures were seven OpenAI LLM/native cases, including missing OpenAI binding. Independent LLM, Codex and session/task commands passed. Subsequent deterministic reduction isolated the task-test environment restoration defect documented below. The initial FAIL remains retained; the identical aggregate now passes **816 passed, 1 skipped, 0 failed, 2,002 assertions, 19 files**, including the added restoration assertions. No production auth fallback or per-file isolation was introduced to make this invocation pass.

Generator was rerun twice after interruption; all five recorded artifact fingerprints again matched. Source-link extraction retained 97 URLs with no generated diff. Final guards pass: annotations, facade ratchet (6 classified source sites /203 test references), workflow allowlist (33), Markdown padding, formatting, and diff whitespace. The facade ratchet now explicitly classifies the two actual HTTP/export integration-test boundaries rather than bypassing the rule or moving their setup to a different database.

## M11 Unexecuted Surfaces

- NOT RUN: released historical binaries and historical client application execution. Archived source modules and inspected historical payloads are not equivalent evidence.
- NOT RUN: full downgraded application/client flows. Ten SQLite producer/reader transitions cover source-level storage compatibility only.
- NOT RUN: process-kill migration crash phases. Existing SQL rollback-trigger tests do not substitute for crash injection.
- NOT RUN: Windows and macOS platform qualification; neither runner is available locally.
- NOT RUN: hosted branch qualification. No hosted run evidence was obtained.

## Authorized M10 Subsection Matrix

Status applies to the complete subsection, not merely its passing subset. NOT RUN also denotes incomplete coverage of a required combination. Original headings are retained; evidence limits are not silently promoted to PASS.

| Subsection | Status | Evidence / Remaining Limit |
|---|---|---|
| M10.1 Poisoned Credential Sources | NOT RUN | Real Provider SDK auth-boundary/config poison tests pass. Not every normal-turn and named utility caller has executed the complete poison matrix through its own call site. |
| M10.2 A/B Identity Isolation | NOT RUN | Real SDK cache A/B/A, actual OAuth refresh A, B, delete A, final B and overlapping real profile-store transport dispatches pass. Simultaneous full normal-turn/utility pipelines remain unexecuted. |
| M10.3 Default Mutation Attacks | NOT RUN | Frozen resolver identity, actual automatic retry after A-to-B default/env/legacy mutation, and client target tests pass. Complete UI/only-account/label/small-model/default-model permutation matrix not executed. |
| M10.4 Deletion Races | NOT RUN | Pre-dispatch rejection, separate-process refresh-waiter deletion and real store deletion after transport handoff pass. Every specified deletion phase through full normal-session and standalone utility pipelines has not been executed. |
| M10.5 Refresh/Reauth CAS Races | NOT RUN | Revision ordering, stale refresh/reauth rejection, remote-identity replacement rejection, and cross-process refresh coordination pass. All full reauth-route race combinations are not demonstrated by direct CAS operations. |
| M10.6 Session Assignment/Repair Races | NOT RUN | Real service admission barrier and objective repair restrictions pass; complete race/operational-state matrix and independent-process assignment/repair admission remain unexecuted. |
| M10.7 Child/Fork/Replay Attacks | NOT RUN | Real parent/child/fork binding persistence, metadata forgery rejection, HTTP info/messages, events and export tested. Actual full resume/replay attack campaign and process restart are not implied by `ensureBinding` or durable metadata inspection. |
| M10.8 Utility Source-Session Injection | NOT RUN | Real common resolver accepts valid current source and rejects actual stored sessions from other directory/project contexts, deleted, synthetic and nonexistent IDs. Complete per-call-site attack combinations are not claimed. |
| M10.9 Standalone Utility Context Attacks | NOT RUN | Strict DTO decoding, missing/invalid/incompatible account context, authority lifecycle and CLI failure tests pass. Complete hostile-field matrix at every standalone caller is not demonstrated by common decoder tests alone. |
| M10.10 Prepare/Generate TOCTOU | NOT RUN | Same captured model becoming unavailable and enhancement selection-default mutation pass through real prepare/generate functions with existing model/generation fault seams. All configuration-mutation combinations for both utilities remain unexecuted. |
| M10.11 Native Runtime Attack | NOT RUN | Real non-profile native Anthropic positive control passes with profiles enabled. Real profile SDK routing and native dispatch-stub negative control pass; all specifically named profile-derived native utility call sites are not claimed executed. |
| M10.12 Usage Isolation | PASS | Existing real account/revision-keyed usage tests plus cache expiry, concurrent expired-token fetch/refresh, deletion/stale-value and static-failure API tests. Auth health and credential state are asserted independently of usage failure. |
| M10.13 Secret Leakage Campaign | NOT RUN | Reproduced profile session error leak corrected; real terminal/offline logs, PostHog completion capture and configured production OTLP log/trace capture from a hostile failed session pass. Other sinks and complete requested surface/caller combinations remain unexecuted. |
| M10.14 Error Sanitization | NOT RUN | Corrected static profile session diagnostics, offline messages and retry handling pass, alongside usage/utility error DTOs/logs. Complete error-origin/caller combinations are not demonstrated. |
| M10.15 Quota and Failure Non-Routing | NOT RUN | Real SDK separate 429/401/network failures and actual barrier-controlled retry remain on A; deleted A fails closed. Full normal-session and utility timeout/DNS/malformed-response matrix not executed. |
| M10.16 Cross-Process Qualification | NOT RUN | Actual Bun processes with real SQLite cover duplicate creation, remote identity, refresh coordination/deletion, turn/exclusive locks and independent backend stores. Independent-process assignment/repair admission remains NOT RUN. |
| M10.17 Client Boundary Qualification | NOT RUN | Current VS Code/JetBrains real client unit/services, credential-free DTO and reconnect checks plus actual old-payload HTTP protocol tests pass. Historical client binaries were inspected, not executed; complete client/backend permutations are not claimed. |

## Final Disposition

### M10 Corrective Closure Follow-Up

The follow-up authorization retains the same fixed baseline and unstaged worktree. The exact aggregate reproduced its 808 passed /1 skipped /7 failed result with Bun 1.4.2 (`744846f84`). Deterministic reduction isolated `test/tool/task.test.ts` as the only necessary predecessor: task + LLM produced 62 passed /6 failed; task + recorded native produced 37 passed /1 skipped /1 failed. Targets without that predecessor passed.

The migration test in that predecessor captured an absent `KILO_EXPERIMENTAL_PROVIDER_PROFILES`, deleted it, then enabled it during profile assertions. Its finalizer restored only originally defined values, leaving the flag at `1` after teardown when originally absent. Subsequent real session creation therefore admitted profile-required/unbound authority instead of the explicit legacy fixture expected by the OpenAI tests. This is a **MAJOR qualification infrastructure defect**, because it can obscure genuine authority regressions; no production context/cache isolation violation was demonstrated. The correction is symmetric environment restoration in that test file, not a new production auth fallback.

Post-correction aggregate checkpoint: **816 passed /1 skipped /0 failed /2,000 assertions /19 files**, including the new cleanup regression. Final integration rerun and expanded remaining-evidence ledger follow below. Earlier failed aggregate evidence remains recorded above and is not erased.

Final unchanged aggregate rerun after the restoration regression also covers explicit `0` and `1`: **816 passed /1 skipped /0 failed /2,002 assertions /19 files**. Working directory is `packages/opencode`; the exact original argument list and order is the aggregate command recorded above. One Bun process executes all 19 discovered files; no per-file process isolation was added to make this result pass. Bun controls discovery/execution order, so CLI argument order is not represented as an execution-order guarantee. Process preload creates PID-specific XDG/test-home paths and an in-memory SQLite database, installs the fixture model catalog, enables event/workspace flags and clears provider API keys and OTLP endpoint/header variables. Initial profile/native/auth-content/OpenAI-key environment variables were unset. No replacement global fetch, provider-cache reset, production runtime change or new auth policy was needed.

The exact original failures were:

- `llm.test.ts`: sends responses API payload for OpenAI models.
- `llm.test.ts`: keeps supported OpenAI models on AI SDK path when native flag is off.
- `llm.test.ts`: streams OpenAI through native runtime when opted in.
- `llm.test.ts`: uses injected native request executor for tool calls.
- `llm.test.ts`: executes OpenAI tool calls through native runtime.
- `llm.test.ts`: accepts user image attachments as data URLs for OpenAI models.
- `llm-native-recorded.test.ts`: OpenAI OAuth: drives a tool loop to a final text answer.

Each was additionally run alone in a fresh Bun process with `bun test <owning-file> --test-name-pattern '<exact title above>'`: seven invocations, each 1 passed /0 failed; assertions respectively 8, 4, 10, 5, 4, 3 and 8. Full owning files also passed independently before correction (33/103 and 3 passed /1 skipped /24). The focused predecessor is the task test `session binding migration persists once and cannot assign during an admitted turn`; the order-sensitive regression executes it followed by affected OpenAI SDK and recorded native targets in the same child process. The wrapper was empirically mutation-tested: reinstating the original asymmetric absent-flag restoration produced child exit 1 and a failing wrapper; restoring the correction produced 1 passed /4 assertions with all three child tests passing. This controlled replay altered no committed history and preserved all other work. The new restoration test saves/restores its own original flag too, so it does not introduce pollution when initially enabled.

The enhancement sibling now tests the same prepared model becoming unavailable, returning the static model-unavailable error before authority/model-language/generation dispatch, and mutable default selection changing after prepare without changing the captured generation model. Existing model/language/generation fault seams are used for these boundary cases; they do not claim an empirical provider catalog reload or SDK dispatch (covered separately). The real HTTP commit/enhance handlers additionally reject seven hostile DTO shapes apiece (credential, authorization headers, nested API/header fields, session/account context smuggling, and model credential fields) before any model or generation call. Caller-input schema diagnostics can echo rejected values; this observation is distinct from provider/internal diagnostic leakage and is not promoted to a no-echo security PASS. No blanket caller-input redaction policy or generic schema middleware redesign was introduced.

| Corrective Closure Check | Exact Command / Working Directory | Result |
|---|---|---|
| Order-sensitive regression | `bun test test/kilocode/task-profile-order.test.ts`, `packages/opencode` | PASS: 1 test /4 assertions. Original-cleanup mutation failed, corrected teardown passes. |
| Each original failure | `bun test test/session/llm.test.ts --test-name-pattern '<title>'` for the six listed LLM titles; `bun test test/session/llm-native-recorded.test.ts --test-name-pattern 'OpenAI OAuth: drives a tool loop to a final text answer'`, `packages/opencode` | PASS: 7 fresh-process invocations /42 assertions total. |
| Retained utility controls | `bun test test/kilocode/qualification/utility-inference.test.ts`, `packages/opencode` | PASS: 14 tests /111 assertions; actual A/B/refresh/delete SDK cache and deterministic automatic retry retained. |
| Real native positive control | `KILO_EXPERIMENTAL_PROVIDER_PROFILES=1 KILO_RECORDED_SCENARIO=anthropic-api-key bun test test/session/llm-native-recorded.test.ts`, `packages/opencode` | PASS: 1 test /8 assertions; real native non-profile cassette execution. |
| Extended utility boundary cases | `bun test test/kilocode/qualification/client-protocol.test.ts test/kilocode/enhance-prompt-authority.test.ts`, `packages/opencode` | PASS: 5 tests /82 assertions /2 files; HTTP DTO rejection and same-model enhancement failure. |
| Additional enhancement default mutation | `bun test test/kilocode/enhance-prompt-authority.test.ts`, `packages/opencode` | PASS: updated file 3 tests /40 assertions, including preserved prepared identity after selection default changes. |
| Retained secret/error controls | `bun test test/kilocode/session-error-logs.test.ts test/kilocode/session-profile-error.test.ts`, `packages/opencode` | PASS: 4 tests /36 assertions. |
| Core | Exact 11-file `--timeout 60000` command above and `bun run typecheck`, `packages/core` | PASS: 118 tests /565 assertions; typecheck passes. |
| VS Code targeted utility/account | `bun test tests/unit/utility-account.test.ts tests/unit/provider-accounts.test.ts tests/unit/kilo-provider-utility-enhance.test.ts tests/unit/kilo-provider-utils-enhance-error.test.ts tests/unit/model-selector-utils.test.ts`, `packages/kilo-vscode` | PASS: 62 tests /126 assertions /5 files. |
| VS Code commit source spec | `bun test src/services/commit-message/__tests__/index.spec.ts`; `bun run typecheck`, `packages/kilo-vscode` | PASS: 14 tests /23 assertions; host/webview typecheck passes. |
| JetBrains targeted backend | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem xvfb-run -a ./gradlew :backend:test --tests 'ai.kilocode.backend.app.KiloBackendChatManagerTest' --tests 'ai.kilocode.client.session.controller.PromptEnhancerTest'`, `packages/kilo-jetbrains` | PASS: backend class 25 tests; frontend pattern is not counted as frontend execution here. |
| JetBrains targeted frontend | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem xvfb-run -a ./gradlew :frontend:test --tests 'ai.kilocode.client.session.controller.PromptEnhancerTest'`; `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem ./gradlew typecheck`, `packages/kilo-jetbrains` | PASS: 11 tests; typecheck passes. |

### Remaining Evidence Classification

The following separates availability from completion. **Executable Now does not mean PASS**: passing a bounded subset does not close a complete mandatory matrix. No remaining gap has been established to require a provider/account architectural redesign.

| M10 Subsection | Missing Evidence Classification | Remaining Scope |
|---|---|---|
| M10.1 | Executable Now | Complete poisoned credential combinations at every normal-turn/utility call site, beyond the real resolver/SDK and caller subsets. |
| M10.2 | Executable Now | Simultaneous normal-turn/utility identities; real SDK sequential cache refresh/deletion already passes. |
| M10.3 | Executable Now | Remaining UI/single-account/label/default/small-model mutation permutations. |
| M10.4 | Executable Now | Every specified normal-session and standalone transport-handoff deletion phase. |
| M10.5 | Executable Now | Remaining route-level refresh/reauth race combinations; direct CAS evidence alone is insufficient. |
| M10.6 | Executable Now | Remaining operational admission matrix and independent-process assignment/repair. |
| M10.7 | Executable Now | Actual restarted-backend replay/resume attack campaign; inspected durable metadata and in-process resume are narrower. |
| M10.8 | Executable Now | Remaining per-caller source-context injection combinations beyond the common real resolver. |
| M10.9 | Executable Now | Remaining non-HTTP standalone callers' hostile-field combinations. Both HTTP utility schema rejection paths are now empirically tested. |
| M10.10 | Executable Now | Remaining configuration mutation combinations beyond same-identity unavailable-model checks for both utilities. |
| M10.11 | Executable Now | Remaining profile-derived utility/native caller combinations beyond actual SDK routing and real non-profile positive control. |
| M10.12 | Complete For Recorded Subsection | Existing real usage isolation/cache/lifecycle tests pass; no extra missing usage case was identified in this review. |
| M10.13 | Other Caller Matrices Executable Now | PostHog sink, actual session logs and real hostile-session OTLP log/trace exporter capture pass. Complete requested sink/caller combinations remain unexecuted; no broad telemetry PASS. |
| M10.14 | Executable Now | Remaining error-origin/caller combinations beyond the corrected provider/offline/quota/session and utility/usage subsets. |
| M10.15 | Executable Now | Remaining normal-session/utility timeout, DNS and malformed-response permutations. |
| M10.16 | Executable Now | Independent-process assignment/repair admission; process/store/refresh/deletion subsets already pass. |
| M10.17 | Current Client Permutations Executable Now; Historical Binaries Unavailable External Environment | Current relevant client tests pass. Inspected historical payloads are not executed historical applications. |

The utility call-site batch (10 files, 54 passed /203 assertions) and session admission/replay/error batch (4 files, 54 passed /404 assertions) were rerun during review; these are retained subset execution, not new full-matrix evidence. New adversarial combinations and final complete-group results are recorded below.

New `qualification/adversarial-cases.test.ts` adds three bounded cases (3 passed /13 assertions): prepared enhancement keeps its captured model/profile reference after a controlled selection-default mutation; two real profile-store dispatches overlap using readiness/release promises and retain distinct credentials/revisions; deleting an account after actual transport handoff allows only the already-started response to finish and rejects later dispatch. These are model fault-seam and real store/dispatch transport-boundary tests, not a claim that simultaneous full normal-session and utility HTTP pipelines have been executed. The filename and trace label are milestone-independent at the user's request.

An initial `qualification/otlp-exporter-qualification.test.ts` control (1 passed /6 assertions) established interception of the production Observability exporter with a loopback collector. The final test now additionally executes the actual hostile session HTTP case in a Bun child with collector configuration loaded before the standard preload clears OTLP variables. Separate preload controls and runtime batches both arrive at `/v1/logs` and `/v1/traces`, and collector header checks establish that the intended exporter is used. Runtime batches exclude the synthetic access, refresh, provider-error and environment markers. User transcript auth-content markers are intentionally outside this provider/internal secrecy assertion; no blanket transcript redaction was introduced. This is scoped actual exporter/pipeline evidence, not a global telemetry PASS.

The focused command `bun test test/kilocode/qualification/otlp-exporter-qualification.test.ts test/kilocode/session-authority-qualification.test.ts` initially failed under concurrent lint/aggregate execution: **5 passed /1 failed /1 unhandled error /94 assertions**, with the parent OTLP test timing out at Bun's default five seconds and the dangling child terminated with exit 143. The wrapper now declares a 60-second timeout, encompassing its separate positive-control process and child test (which retains a 30-second timeout). The identical command then passed **6 tests /110 assertions /2 files**. The latest complete 24-file command passed **105 tests /663 assertions** after that correction. No test assertions or production exporter policy were weakened.

Latest integration checks: exact original single-process aggregate **816 passed /1 skipped /0 failed /2,002 assertions /19 files**; backend typecheck PASS; root typecheck **30/30 successful, 29 cached**; bounded full root lint **11,065 warnings /0 errors /6,159 files**; targeted Prettier PASS; annotation/facade/workflow/Markdown guards PASS. Annotation guard includes the task test correction; facade guard remains **6 classified runtime sites /203 classified test references**. Older failures and checkpoint results remain above rather than being silently overwritten.

**M10–M11 QUALIFICATION FAIL — CORRECTIVE WORK REQUIRED**

The scoped priority closure tests pass, the reproduced profile session leak is corrected, and the aggregate test-pollution defect is resolved with a mutation-tested order-sensitive regression. Actual hostile-session OTLP log/trace export is now observed and passes the bounded provider/internal secrecy assertions. Full qualification remains unsuccessful because mandatory M10 combinations and M11 platform/binary/crash campaigns remain NOT RUN. The extra task-nesting regression remains FAIL and is empirically attributable to baseline sources. No architectural expansion was needed; no M12 work was started. All changes remain unstaged and uncommitted.

## Final Repository Audit

Verified HEAD `2547dd8f908a8dfcd16d0d3396b46933720f52db`; branch `feat/provider-account-profiles`; `git diff --cached --name-only` empty. No commits or pushes were performed. Inventory contains 16 modified tracked files and 22 untracked files (38 total), all qualification work preserved:

```text
M packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/app/KiloBackendChatManager.kt
M packages/kilo-jetbrains/backend/src/test/kotlin/ai/kilocode/backend/app/KiloBackendChatManagerTest.kt
M packages/kilo-jetbrains/backend/src/test/kotlin/ai/kilocode/backend/testing/MockCliServer.kt
M packages/kilo-jetbrains/frontend/src/main/kotlin/ai/kilocode/client/session/controller/SessionController.kt
M packages/kilo-jetbrains/frontend/src/test/kotlin/ai/kilocode/client/session/controller/PromptEnhancerTest.kt
M packages/kilo-jetbrains/frontend/src/test/kotlin/ai/kilocode/client/testing/FakeSessionRpcApi.kt
M packages/kilo-jetbrains/shared/src/main/kotlin/ai/kilocode/rpc/dto/EnhancePromptDto.kt
M packages/kilo-vscode/src/services/commit-message/__tests__/index.spec.ts
M packages/kilo-vscode/tests/unit/utility-account.test.ts
M packages/opencode/src/cli/cmd/agent.ts
M packages/opencode/src/kilocode/session/processor.ts
M packages/opencode/src/session/llm.ts
M packages/opencode/src/session/processor.ts
M packages/opencode/test/kilocode/enhance-prompt-authority.test.ts
M packages/opencode/test/tool/task.test.ts
M script/check-opencode-promise-facades.ts
?? .changeset/qualify-utility-authority-boundaries.md
?? .kilo/plans/provider-account-m10-m11-qualification.md
?? packages/core/test/fixture/kilocode-qualification-history-worker.ts
?? packages/core/test/fixture/kilocode-qualification-legacy-reader.ts
?? packages/core/test/kilocode/provider-profile-history-qualification.ledger.json
?? packages/core/test/kilocode/provider-profile-history-qualification.test.ts
?? packages/core/test/kilocode/provider-profile-qualification.test.ts
?? packages/core/test/kilocode/qualification-migration.test.ts
?? packages/opencode/test/kilocode/qualification/adversarial-cases.test.ts
?? packages/opencode/test/kilocode/qualification/cli-boundary.test.ts
?? packages/opencode/test/kilocode/qualification/client-protocol.test.ts
?? packages/opencode/test/kilocode/qualification/otlp-after-preload.ts
?? packages/opencode/test/kilocode/qualification/otlp-before-preload.ts
?? packages/opencode/test/kilocode/qualification/otlp-child.bunfig.toml
?? packages/opencode/test/kilocode/qualification/otlp-exporter-qualification.test.ts
?? packages/opencode/test/kilocode/qualification/usage-security-api.test.ts
?? packages/opencode/test/kilocode/qualification/usage-security-cache.test.ts
?? packages/opencode/test/kilocode/qualification/utility-inference.test.ts
?? packages/opencode/test/kilocode/session-authority-qualification.test.ts
?? packages/opencode/test/kilocode/session-error-logs.test.ts
?? packages/opencode/test/kilocode/session-profile-error.test.ts
?? packages/opencode/test/kilocode/task-profile-order.test.ts
```

## Linux Corrective Closure: Execution History

The user renewed authorization on 2026-10-06 to complete remaining realistically executable M10 evidence, excluding Windows/macOS. The preceding results, NOT RUN matrix and repository inventory remain the prior checkpoint; they are not silently promoted by this continuation. M11/M12 remain out of scope, and HEAD/index/commit restrictions are unchanged. New qualification work below must be reconciled before a final disposition.

All Bun commands in this continuation prepend `PATH=/tmp/kilo/bun-tooling/node_modules/.bin:$PATH` and use Bun 1.4.2 (`744846f84`). All credentials remain synthetic. Test seams that replace generation or exercise only authority resolution are distinguished from successful production caller/Provider/SDK transport executions.

| Execution | Command / Boundary | Result |
|---|---|---|
| Retained order/retry/cache controls | `packages/opencode`: `bun test test/kilocode/task-profile-order.test.ts test/kilocode/qualification/utility-inference.test.ts` | PASS: 15 tests /115 assertions. Includes actual order-sensitive subprocess, automatic retry identity and SDK A/B/A/refresh/deletion controls. |
| Retained native positive control | `packages/opencode`: `KILO_EXPERIMENTAL_PROVIDER_PROFILES=1 KILO_RECORDED_SCENARIO=anthropic-api-key bun test test/session/llm-native-recorded.test.ts` | PASS: 1 test /8 assertions. Real non-profile native transport; does not replace profile caller qualification. |
| Core plus independent-process admission | `packages/core`: prior exact 11-file core command plus `test/kilocode/provider-profile-admission-qualification.test.ts`, with `--timeout 60000` | PASS: 119 tests /590 assertions /12 files. New test uses two independent Bun processes and disk SQLite, readiness/release barriers with no sleeps. It qualifies the lock substrate, not the actual assignment/repair route policy. |
| Original broad aggregate | Exact 19-file command in the aggregate corrective section above, unchanged | PASS: 816 passed /1 skipped /0 failed /2,002 assertions. No unexplained aggregate failure. |
| VS Code relevant utility/account group | `packages/kilo-vscode`: `bun test tests/unit/utility-account.test.ts tests/unit/provider-accounts.test.ts tests/unit/kilo-provider-utility-enhance.test.ts tests/unit/kilo-provider-utils-enhance-error.test.ts tests/unit/model-selector-utils.test.ts` | PASS: 62 tests /126 assertions. |
| VS Code commit-message boundary | `packages/kilo-vscode`: `bun test src/services/commit-message/__tests__/index.spec.ts` | PASS: 14 tests /23 assertions. |
| VS Code added current boundary cases | `packages/kilo-vscode`: `bun test tests/unit/qualification-client-boundary.test.ts tests/unit/provider-accounts.test.ts tests/unit/utility-account.test.ts` | PASS: 15 tests /52 assertions. Frozen/stale session target, credential-free projection, no implicit default/only-account assignment and repair eligibility. |
| VS Code complete unit suite | `packages/kilo-vscode`: `bun run test:unit` | PASS: 6,709 passed /24 skipped /0 failed /40,567 assertions /516 files. Expected error-path logs do not represent test failures. |
| JetBrains backend boundary | `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem LD_LIBRARY_PATH=/tmp/kilo/awt-runtime/usr/lib/x86_64-linux-gnu xvfb-run -a ./gradlew :backend:test --tests 'ai.kilocode.backend.app.KiloBackendChatManagerTest' --tests 'ai.kilocode.backend.app.QualificationClientBoundaryTest'` | PASS: XML counts 25 +1 tests. Existing stale reconnect rejects generation before replacement backend dispatch; new prepared-account-removal case forwards frozen identity and handles a backend 404 safely. The fake API does not itself qualify backend account deletion enforcement. |
| JetBrains frontend boundary | Same Java/AWT/Xvfb environment: `./gradlew :frontend:test --tests 'ai.kilocode.client.session.controller.PromptEnhancerTest' --tests 'ai.kilocode.client.session.controller.QualificationClientBoundaryTest'` | PASS: XML counts 11 +5 tests. Enabled/disabled/unsupported context, captured session/model and picker-choice cancellation. Choice-helper cancellation is not automation of the IntelliJ dialog. |
| Client/core checks | Core typecheck; VS Code typecheck/lint/knip/check-kilocode-change; JetBrains `./gradlew typecheck` | PASS. Targeted Prettier first rejected the completed VS Code boundary file; formatting was applied. Final integrated checks remain required after all backend additions stabilize. |

Historical deployed client applications/binaries remain NOT RUN because none were provisioned for this campaign. Current source/API-seam execution is not credited as historical application execution. Windows/macOS are excluded by the renewed user scope, not counted as passing. The all-caller poison/native/source/config, full session operational/restart/assignment, lifecycle transport and actual failure sink matrices remain active work, not a completed qualification claim.

### Standalone and Enhancement Caller Evidence

`packages/opencode`: `bun test test/kilocode/qualification/caller-matrix.test.ts test/kilocode/qualification/standalone-callers.test.ts test/kilocode/qualification/roll-call.test.ts` passes **11 tests /102 assertions /3 files** in one process. This command joins the actual caller-specific SDK additions rather than relying only on the resolver operation table.

| Caller | Actual Executed Boundary | Evidence / Limit |
|---|---|---|
| Enhancement | Real preparation, real profile store/source session/resolver/Provider, real OpenAI SDK with synthetic HTTP transport | Both explicit A and source-bound A dispatch successfully after label/default/project model/small-model mutation, preserving prepared model and A bearer/account. Captured-model unavailability and account deletion cause no new SDK request. Config API key/base URL/Authorization overrides fail closed before transport. Owned file: 4 tests /36 assertions. |
| Commit-message | Actual generation through production application runtime and SDK; config and hostile header-hook fault injection | A remains A after default/environment/legacy mutation. Native opt-in still uses SDK; a poisoned `chat.headers` hook cannot replace A wire auth. Config key/base URL/auth-header table rejects before SDK dispatch. Missing/wrong/deleted A and strict DTO credential/session smuggling reject. |
| Agent generation | Actual `Agent.generate`, real resolver/store/Provider SDK; available legacy OAuth fault seam and synthetic HTTP | A is used despite available legacy OAuth and environment poison, defaults and injected credential properties. Config key/base URL/auth-header overrides reject; missing/wrong/deleted A causes no request. Typed direct-call input ignores excess credential fields, but they grant no authority and do not reach transport. No new runtime schema was invented for this internal typed function. Standalone file (commit + Agent): 6 tests /52 assertions. |
| Roll-call | Actual exported CLI handler against production application runtime and real SDK, synthetic HTTP | Explicit A with B default survives ambient poison and native opt-in; missing/omitted/deleted account and a hostile model Authorization header produce no added request. Owned file: 1 test /14 assertions. Source-session context prohibition is separately executed through the real operation resolver, not represented as a CLI source-session RPC. |

Enhancement has no `Plugin.Service`/`chat.headers` invocation: plugin auth-hook injection is not a reachable caller input there, rather than an unexecuted hook being claimed safe. Its real config/auth acquisition boundaries are exercised above. The commit hook fault seam is reachable and executed separately. Resolver-only branch/title/memory source-table evidence is retained as such until their actual caller paths are integrated.

In-progress backend typecheck failures identified branded provider IDs, obsolete Effect combinators, lifecycle Promise/Effect composition, telemetry import/spy typing and CLI argument shapes. These were sent to each active file owner, not dismissed as inherited. Parent temporarily added a roll-call `legacy-auth` argument alias during reconciliation, then removed it after confirming the completed test calls the Kilo handler's own `legacyAuth` input rather than the upstream yargs handler. Runtime-facade guard failures identified new integration files and exact-count drift; each intentional production-runtime boundary is explicitly classified without raising the runtime/test ratchets or accepting wildcard exceptions. Final typecheck and guard PASS remain required after reconciliation.

### Additional Failure Found and Corrected

The real failure caller matrix reproduced raw `AI_APICallError` escape from `Agent.generate`, including the synthetic `SECRET_PROVIDER_ERROR` and `SECRET_REFRESH_A` diagnostics. This is an additional **BLOCKER security boundary defect**, not a reversal of the accepted session/offline/quota fixes. `Effect.promise` treats rejected SDK promises as defects, while the existing `Effect.mapError` only maps typed errors. The Agent streaming-object iteration and generated-object promise therefore bypassed their intended static `UtilityAccount.Failure` mapping.

The coordinator replaced those two existing promise/mapError boundaries with narrowly annotated `Effect.tryPromise({ try, catch })` in `packages/opencode/src/agent/agent.ts`. It preserves the existing safe failure policy and frozen provider/account architecture, and catches asynchronous stream/parser rejection as a typed static failure. No raw provider details, blanket transcript redaction, new auth fallback, native routing change or Promise facade was added. The existing qualification changeset now includes agent-generation failures.

`packages/opencode`: `bun test test/kilocode/qualification/caller-matrix.test.ts test/kilocode/qualification/standalone-callers.test.ts test/kilocode/qualification/roll-call.test.ts test/kilocode/qualification/failure-matrix.test.ts test/kilocode/agent-generation-authority.test.ts` passes **17 tests /365 assertions /5 files** after the correction and test audit cleanup. This includes successful Agent SDK execution and the actual previously failing rejected Agent SDK path; the failure matrix alone passes **2 tests /250 assertions**.

The actual session failure table covers malformed HTTP 400, HTTP 401, HTTP 429 quota, HTTP 503 quota, malformed OAuth refresh response, timeout, and DNS/cause-chain failures. Real profile resolution remains pinned to A while B is default and ambient credentials are poisoned. It observes actual HTTP session/info/messages, persisted error, live events, durable replay, sanitized export and completion telemetry, and preserves ordinary intentional transcript content. The offline case uses the existing rejected-network permission seam with no sleeps. An early apparent offline hang was actually an unbounded durable-replay consumer asking for 50 events; it was corrected to await one matching session update. That failed attempt remains recorded rather than becoming positive evidence.

The same matrix executes real Agent and roll-call 401 failures. Its enhancement/commit HTTP response tests use their existing generation fault seam and are scoped public-handler evidence; additional actual SDK failure-table execution remains active work. Existing memory ports/integration rerun **33 tests /106 assertions** proves those seams, not successful caller SDK transport. Terminal/offline/profile errors and utility inference rerun **18 tests /147 assertions**; real OTLP collector rerun **1 test /17 assertions**. AI SDK `ai.*`/`gen_ai.*` span recording is explicitly disabled by production `KiloAgent.telemetryOptions`, so an optional synthetic telemetry-on path would not qualify a reachable caller behavior. Configured production log/trace export remains separately empirically observed.

### Operational Admission and Restart

`packages/opencode`: `bun test test/kilocode/qualification/session-admission.test.ts` passes **5 tests /33 assertions** after coordinator reconciliation. Actual pending permission and question requests, Task subagent transport, and compaction transport reject assignment/confirmed repair while the real parent turn is held. Permission/question release uses production reply APIs. Parent corrected mixed branded request IDs and changed `TestLLMServer.hold` gates from Effect values (not awaited PromiseLike) to real `Promise.withResolvers` barriers, then reran; earlier test-only results are not credited as proving a transport hold that the server did not await.

The restart fixture stops one actual backend process and starts another against the same disk SQLite database. It replays hostile metadata and tries reassignment, then successfully prompts the pre-existing bound session: wire A identity and previous-turn history survive and the expected resumed response marker returns. Initial restart fixture configuration contained a forbidden base URL override and correctly failed closed; the fixture now intercepts the allowed official Codex transport without configuring a conflicting URL. Original accepted replay tests and failure history are retained. The worker's combined admission/session-authority/session-resume/profile-error command passed **58 tests /427 assertions** before final gate reconciliation; the focused final admission rerun above confirms the corrected barriers.

### Qualification Infrastructure Audit

An independent read-only audit identified vacuous secret assertions on identity-only resolver records, missing request-body capture, a static JetBrains DTO `toString` assertion with no hostile input, and assertion-dependent account cleanup. Coordinator removed the vacuous assertions, captured serialized headers plus actual body in standalone/roll-call wire records, added unconditional account cleanup, and removed the ineffective JetBrains assertion. Roll-call now changes cwd to its scoped temporary instance and disposes the matching production-runtime directory cache before restoring cwd/env/fetch, instead of priming the repository-directory Provider cache. A delegated cleanup attempt initially lacked the pinned Bun PATH and left unfinished edits; coordinator reconciled them and ran the 17/365 command above plus formatting.

The new core admission worker initially lived in a shared upstream fixture path without a marker. Rather than annotating a Kilo-specific fixture in a shared name, the coordinator moved it to `test/fixture/kilocode-provider-profile-admission-worker.ts` and updated its launcher. Its focused rerun passes **1 test /25 assertions**, and the annotation guard passes with the Agent correction. No failed attempt or external limitation is erased by this continuation.

### Direct Enhancement Failure and Successful Source Callers

The real standalone SDK fault table subsequently reproduced direct `enhancePrompt` rejection with raw response diagnostics `SECRET_PROVIDER_ERROR SECRET_ACCESS_A` on 401. The HTTP wrapper's static failure handling did not protect internal direct callers. This additional **BLOCKER direct-call diagnostic boundary defect** was corrected minimally in the Kilo-owned enhancement module: profile-only language acquisition and generation rejections map to the existing static `UtilityAccount.Failure("account-unavailable")`; legacy/non-profile errors preserve their prior behavior. The failure table now asserts static enhancement errors and absence of every `SECRET_` marker instead of accepting the unsafe rejection. The changeset includes direct enhancement as well as Agent.

The standalone table executes seven actual SDK scenarios for each of enhancement and commit-message: authorization 401, quota 429, quota 503, malformed 400, timeout, nested DNS cause and malformed OAuth refresh. Wire account/bearer remains A, requests are bounded, and no B/environment/legacy substitution occurs. A transitional joined run failed because an older enhancement override test expected the intentionally removed provider-initialization cause. That failed assertion also left a default-profile row and contaminated the following source test; unconditional account cleanup and explicit `Session.assignBinding` seeding replaced metadata/automatic-default assumptions. A syntax error during that reconciliation was corrected and is not suppressed. These failures are qualification test corrections, not evidence for changing production default policy.

`packages/opencode`: `bun test test/kilocode/qualification/standalone-failures.test.ts test/kilocode/qualification/caller-matrix.test.ts test/kilocode/enhance-prompt-authority.test.ts test/kilocode/qualification/memory-caller.test.ts test/kilocode/qualification/title-caller.test.ts` then passed **10 tests /246 assertions /5 files**.

| Source Caller | Actual Pipeline Evidence | Failure Attempts / Limits |
|---|---|---|
| Branch-name | Actual source-bound branch generator resolves A and dispatches the real Responses SDK despite B default and poisoned environment/auth content; synthetic/missing source causes no added request. Focused 1 test /12 assertions. | Resolver-only operation tests remain separately classified; no claim that their wire assertions establish named caller dispatch. |
| Automatic title | Production `SessionPrompt.prompt` on a default-title session invokes private title generation. Actual main `code:gpt-5` and `title:gpt-5-mini` SDK requests both carry A, not B/ambient poison. Title request has the real title system instruction and a published title-update event; final stored title is `TITLE_CALLER_TITLE`. Focused 1 test /15 assertions. | Early attempts lacked complete Responses events and used the wrong legacy-vs-EventV2 callback shape; fixed fixtures, not production. Prompt input has no metadata field, so a synthetic metadata argument is not accepted API coverage. |
| Memory capture | Actual `MemoryTurn.close` uses real source transcript/account store/resolver/Provider/Responses SDK and persists `memory_test_command` in project memory. Wire is A despite B default/environment/auth-content poison. Focused 1 test /6 assertions. | Initial test graph/production AppRuntime contexts differed, producing source-unavailable or generic memory failure with no caller SDK request; a direct SDK probe was explicitly not credited. Coordinator replaced the probe-heavy unfinished fixture with a real Promise instance boundary sharing the production runtime, after which actual capture/persistence passed. No memory production change was made. |

Root typecheck after these reconciliations passes **30/30 tasks, 18 cached** with no remaining diagnostic in that snapshot. The targeted JetBrains backend/frontend boundary command was rerun after removal of the vacuous DTO assertion and passed (backend reused its up-to-date task; frontend re-executed). Bounded root lint passes **11,118 warnings /0 errors /6,179 files**. The complete backend qualification integration is in progress; its first attempt identified the expected enhancement public-error assertion update and an invalid Promise/Effect composition in the lifecycle child. Both remain recorded and require a clean complete rerun before disposition.

### Lifecycle Integration and Full Regression Rerun

The lifecycle campaign now executes real concurrent Session/LLM A and enhancement SDK B transport, default mutation and reauthentication after handoff, account deletion before lookup and after utility-model acquisition, deletion after handoff followed by rejection of later A dispatch, and reauthentication during a shared refresh waiter. B keeps its own bearer/account through A mutation/deletion. Independent live HTTP backend processes share disk SQLite and invoke actual assignment and confirmed repair routes while the owner holds turns; both competing requests receive the expected running-turn conflict, rather than only testing the underlying lock substrate.

The worker's first passing six-test checkpoint asserted initial/retry HTTP statuses `[200, 422]`: wire identities were correct but B enhancement did not complete, so that checkpoint is explicitly **transport/authority evidence only**. Coordinator strengthened the child fixture and assertions to require B success. Both initial provider handoffs now wait for the release barrier (previously only the second waited); external non-loopback discovery requests are intercepted rather than forwarded. Normal streaming and standalone generation receive their respective SSE/JSON Responses shapes. Several strengthened attempts still failed with B 422 until the generated JSON included required `created_at`; that invalid synthetic payload, not demonstrated production B leakage, caused the rejection. The completed initial/retry pairs are now `[200, 200]`, with exactly one pre-deletion A dispatch and two B dispatches. Normal prompt HTTP acceptance after deletion is not claimed as successful provider admission: no subsequent A wire request exists.

The strengthened two real-SDK child cases pass **2 tests /23 assertions**. Earlier SSE fixture and Effect/Promise composition failures remain history, not passing evidence. The exact intermediate normal-session post-language-acquisition phase is being investigated through observational service instrumentation; utility acquisition-phase coverage is not silently substituted for it.

Final complete backend qualification command (working directory `packages/opencode`):

```sh
bun test test/kilocode/qualification test/kilocode/session-authority-qualification.test.ts test/kilocode/session-profile-error.test.ts test/kilocode/session-error-logs.test.ts test/kilocode/session-processor-network-offline.test.ts test/kilocode/provider/utility-authority-lifecycle.test.ts test/kilocode/provider/utility-account.test.ts test/kilocode/utility-runtime-authority.test.ts test/kilocode/enhance-prompt-authority.test.ts test/kilocode/commit-message-authority.test.ts test/kilocode/agent-generation-authority.test.ts test/kilocode/compaction-account-authority.test.ts test/kilocode/cli/utility-account.test.ts test/kilocode/branch-name.test.ts test/kilocode/session-title-generation.test.ts test/kilocode/memory/memory-ports.test.ts test/kilocode/memory/memory-integration.test.ts test/kilocode/task-profile-order.test.ts
```

Result: **133 passed /0 failed /1,294 assertions /34 files** in one Bun process. Existing expected error/warning logs are not test failures. Child-process assertions are not added to the parent count. The original exact broader 19-file aggregate was then run unchanged after all production corrections and this qualification group: **816 passed /1 skipped /0 failed /2,002 assertions**. Provider, LLM/native, Codex and session/task suites are included; the seven original OpenAI failures remain resolved. The separately baseline-reproduced task-nesting failure is retained as inherited, not included in the passing aggregate or silently fixed outside scope.

| Final Check | Result |
|---|---|
| Core exact 12-file qualification/history/admission command | PASS: 119 tests /590 assertions; actual historical-source SQLite transitions retained, not released-binary claims. |
| Backend package typecheck | PASS after all standalone/caller/lifecycle/Agent/enhancement reconciliations. |
| Root `JAVA_HOME=/home/saint/.sdkman/candidates/java/21-tem GOMAXPROCS=2 bun run typecheck --concurrency=2` | PASS: 30/30 tasks, 29 cached. |
| Root `GOMAXPROCS=2 bun run lint --threads=2` | PASS: 11,121 warnings /0 errors /6,179 files. Diagnostics remain enabled. |
| Prettier on complete qualification directory, correction sources, task/enhancement tests, facade guard, core admission files and VS Code boundary file | PASS. |
| Annotation / runtime-facade / workflow / Markdown guards | PASS: no unannotated shared changes; 6 runtime sites /274 explicit test references; 33 workflow entries; no padded tables across 371 Markdown files. |
| `git diff --check` | PASS. |

Repository audit at this regression checkpoint: HEAD `2547dd8f908a8dfcd16d0d3396b46933720f52db`, branch `feat/provider-account-profiles`, empty index, **18 modified tracked +44 untracked files (62 total)**, all unstaged. No commit/push or M12 work. No session/thread cache files were deleted; bounded check concurrency was sufficient. This is an execution checkpoint, not a full M10 PASS while the independent acceptance audit and exact normal-acquisition phase are outstanding.

### Independent Acceptance Audit Follow-Up

The independent audit credits the executed named caller, admission, restart, cross-process, failure and lifecycle slices, but does not promote them to full subsection PASS. It identified the following concrete executable follow-ups; generic unspecified Cartesian combinations are not used as a substitute for identifying a missing test.

| M10 Gap | Classification | Concrete Follow-Up |
|---|---|---|
| M10.4 exact normal post-language-acquisition deletion | Executable investigation active | Observe the real Provider language acquisition from a normal LLM request, pause by delegating observational instrumentation, delete A, then release before HTTP dispatch. No production pause hook or mocked account resolution. |
| M10.5 route-level reauthentication vs stale refresh | Executable investigation active | Use actual SDK/API reauthentication flow against a revision-bound account while real token refresh is gated; assert stale refresh cannot overwrite route reauth. Direct CAS is not route evidence. |
| M10.1/2/3/11 profile compaction wire/native routing | Executable investigation active | Actual SessionCompaction/SessionPrompt pipeline to real SDK transport with A binding, B default, ambient poison, captured small model and native opt-in. Operational compaction admission and generation seams are narrower. |
| M10.14/15 actual Agent and roll-call failure origins | Executable investigation active | Extend the actual 401 caller cases to quota, malformed, timeout, DNS/cause and refresh-parser failures through real SDK/transport, retaining static errors and no replacement identity. |
| M10.13 Agent/roll-call production diagnostic logs | Executable investigation active | Fresh child capture of reachable actual stdout/stderr/log sinks under hostile SDK failures with positive controls. No SDK-span framework is introduced for spans production disables. |
| M10.17 historical deployed client execution | Unavailable external environment | No deployed historical VS Code/JetBrains client applications or binaries were provisioned. Current source and fake/API seams remain scoped current-client evidence. |

The coordinator launched bounded workers for the four executable follow-up units rather than dismissing them as unobservable or declaring all M10 complete based on the green 133-test integration. Windows/macOS remain explicitly excluded, and no M11/M12 qualification or architecture expansion was authorized.

The exact normal-session acquisition interval is now **observed**, superseding the earlier unobservable-boundary hypothesis. `normal-acquisition.test.ts` delegates the real mutable Provider service's `getLanguage` Effect, records its genuine returned language model and selected A/model, and holds that unchanged result with Deferred before transport. Deleting A and releasing causes the actual normal LLM/SDK path to fail closed with `Provider account is unavailable`; global and configured ambient-fetch counts are both zero. No production test hook or provider/account replacement was added. The worker checkpoint passed **1 test /10 assertions**; coordinator added unconditional profile cleanup and removed two redundant secret assertions on an already empty request list, then reran **1 test /8 assertions**. `bun test test/kilocode/task-profile-order.test.ts test/kilocode/qualification/utility-inference.test.ts test/kilocode/qualification/normal-acquisition.test.ts` passes **16 tests /123 assertions**. The non-profile real native cassette control was also rerun: **1 test /8 assertions**.

`reauth-route.test.ts` executes the generated SDK against the actual local provider-account HTTP handlers while an expired A's real OAuth refresh transport is held. The existing OAuth adapter seam supplies synthetic authorization results, rather than executing browser login or replacing the account store. Revision-bound route start and completion advance A to revision 1; releasing the older refresh cannot overwrite it, causes no stale provider dispatch, and a subsequent model request uses only authorized A. Focused worker result: **1 test /15 assertions**. This is actual route/CAS contention evidence, not a claim of real external browser login. Final joined verification remains required.

The compaction follow-up initially assumed `small_model` selected compaction's model, but the frozen implementation intentionally selects the compaction agent's configured model or inherits the user model. Coordinator rejected that invented policy change and asked the fixture to test both inherited main model and explicit compaction-agent model with real SDK transport, source A and native opt-in. The initial model assertion failure is retained as a fixture assumption, not a production defect. Compaction and extended Agent/roll-call SDK/log matrices remain active.

The compaction follow-up now passes **1 test /28 assertions** after coordinator strengthening (worker checkpoint: 26 assertions). Both real `SessionCompaction.create` + `SessionPrompt.loop` cases publish completion, persist summary content, and issue exactly one Responses SDK request each with A identity despite B default and available synthetic legacy OAuth/environment credentials. The first inherits `gpt-5` while unrelated `small_model` is mini; the second uses explicitly configured `agent.compaction.model = openai/gpt-5-mini`. Native opt-in is enabled, and a delegating spy on the real native runtime records **zero native stream invocations** while both real SDK requests complete. Full URL/header/body capture excludes B/poison/refresh data, and no extra HTTP request is allowed. Profiles and observers are finalized unconditionally. No compaction production policy was altered.

Route reauthentication was strengthened to select B as default during A's held refresh. Joined exact-boundary/route rerun passes **2 tests /23 assertions**. The remaining active audit follow-up is the extended actual Agent/roll-call fault and production-log campaign; the complete integration and final per-subsection disposition will follow its verified result.

### Extended Caller Logs and Final Expanded Checkpoint

`caller-failures.test.ts` launches a fresh Bun child invoking real Agent and roll-call entry points with the real production profile store/resolver/Provider SDK. Six additional fault origins per caller produce **12 failure rows**, **14 actual API error responses /20 outbound attempts**, **6 roll-call failure outputs**, and **1 positive production logger control**. The child executes **63 runtime calls** (not 63 extra source references). The parent captures both stdout and stderr and excludes synthetic A access/refresh/provider-error/environment/legacy/B markers from diagnostics. Outbound selected-A Authorization is intentional and verified separately, not treated as a diagnostic leak. Each caller/scenario has a request bound; malformed refresh cannot substitute an ambient account. Coordinator additionally parses every roll-call output and requires `access: false` plus one of the existing static failure messages, rather than inferring failure from an unconditional summary label.

The actual Agent path requires typed `UtilityAccount.Failure` after every fault; the existing `Effect.tryPromise` correction passes this broader campaign. No additional production correction or telemetry framework was required. The fixture's production-runtime exception is explicitly classified at **15 source references**, with a substantive store/entry-point/captured-sink reason. A formatting warning in the completed parent wrapper was fixed; no diagnostic was suppressed.

The exact complete qualification command above, unchanged except that directory discovery includes the four new test files, now passes **137 tests /0 failures /1,374 assertions /38 files**. This supersedes the 133/1,294/34 execution checkpoint without erasing it. Root typecheck passes **30/30 tasks /29 cached** after all follow-ups; final bounded root lint reports **11,131 warnings /0 errors /6,184 files**. Prettier, annotation, facade, workflow, Markdown and whitespace guards pass: **6 runtime sites /289 explicitly classified test references**, unchanged runtime/test ratchets. The original broader aggregate is being rerun unchanged after this latest full group; final acceptance audit and repository inventory follow its result.

## Final Linux Closure Record

The independent follow-up audit inspected the concrete acquisition, reauthentication-route, compaction and Agent/roll-call SDK/log tests and found no further specific realistically executable case from its acceptance-gap list. It did not rerun tests, grant user approval, or certify an unspecified Cartesian product. Coordinator independently executed the integration below. The earlier subsection NOT RUN tables remain historical checkpoints; this record supplies their current concrete evidence rather than deleting prior failures or substituting source inspection for execution.

### Exact Aggregate Targets and State Control

A final deliberately forced-state forensic probe corrects the earlier informal descriptions of the seven affected tests. They are **six cases in `test/session/llm.test.ts` and one in `test/session/llm-native-recorded.test.ts`**, not three request/header cases plus four native-lowering helpers. The earlier prose is retained as an inaccurate checkpoint description, not reused as the final finding.

| Owning File | Exact Test |
|---|---|
| `test/session/llm.test.ts` | `sends responses API payload for OpenAI models` |
| `test/session/llm.test.ts` | `keeps supported OpenAI models on AI SDK path when native flag is off` |
| `test/session/llm.test.ts` | `streams OpenAI through native runtime when opted in` |
| `test/session/llm.test.ts` | `uses injected native request executor for tool calls` |
| `test/session/llm.test.ts` | `executes OpenAI tool calls through native runtime` |
| `test/session/llm.test.ts` | `accepts user image attachments as data URLs for OpenAI models` |
| `test/session/llm-native-recorded.test.ts` | `OpenAI OAuth: drives a tool loop to a final text answer` |

From `packages/opencode`, the isolated forced-state command is:

```sh
KILO_EXPERIMENTAL_PROVIDER_PROFILES=1 KILO_RECORDED_SCENARIO=openai-oauth RECORD=false bun test test/session/llm.test.ts test/session/llm-native-recorded.test.ts --test-name-pattern 'sends responses API payload for OpenAI models|keeps supported OpenAI models on AI SDK path when native flag is off|streams OpenAI through native runtime when opted in|uses injected native request executor for tool calls|executes OpenAI tool calls through native runtime|accepts user image attachments as data URLs for OpenAI models|OpenAI OAuth: drives a tool loop'
```

**Expected negative control:** 0 passed /7 failed /27 filtered /6 assertions. The six legacy fixture assertions see `unbound/profile-required` instead of explicit legacy binding; the native cassette sees the explicit OpenAI account-binding gate. The identical command with only `KILO_EXPERIMENTAL_PROVIDER_PROFILES=0` changed passes **7 tests /0 failures /27 filtered /42 assertions**. This is intentionally injected leaked state in a child process, not an unexplained worktree regression. No source cleanup was temporarily reverted, no shared-process flag was mutated, and no native/auth policy was weakened.

The minimal historical contaminating predecessor remains `test/tool/task.test.ts`'s `session binding migration persists once` test. Its previous teardown changed an initially absent flag to `"1"`; the smallest correction restores absent/`"0"`/`"1"` symmetrically. The order-sensitive subprocess runs that predecessor followed by an actual OpenAI SDK case and actual OpenAI OAuth native recorded case, requires all three to pass, and was mutation-tested against the original teardown. Classification: **MAJOR qualification infrastructure defect**, because process-wide feature-flag pollution changed security/runtime test semantics and could mask or falsely report regressions. It is not evidence of production credential-cache or cross-directory runtime leakage.

### Current Subsection Evidence

`Executed` below means the explicit recorded matrix was run successfully. It does not mean unbounded combinations, unsupported providers, external browser login, released application binaries or full rendered-IDE flows were certified.

| Subsection | Current Evidence | Status |
|---|---|---|
| M10.1 Poisoned Credential Non-Substitution | Real normal, enhancement, commit, Agent, roll-call, branch, title, memory and compaction SDK paths; real credential/default identities plus config/header conflict and reachable hook faults. No account fallback. | Executed |
| M10.2 A/B Identity Isolation | SDK A/B/A/refresh/delete controls plus simultaneous normal A/utility B handoff, real refresh waiter and B survival across A mutation/deletion. | Executed |
| M10.3 Defaults/Labels Only Affect Selection UI | Real prepared enhancement/commit identity/model retention across default/label/config changes; omitted/only/default standalone authority rejection; source utilities/compaction use stored A while B becomes default. | Executed |
| M10.4 Deletion Races | Real normal before-lookup and after genuine language acquisition, utility after acquisition, real handed-off requests, later retries and independent refresh-waiter deletion. | Executed |
| M10.5 Reauthentication Races | Shared-store CAS/refresh races plus real revision-bound SDK/API reauthentication start/complete while old OAuth refresh is held. Synthetic authorization adapter results, not browser login. | Executed |
| M10.6 Operational Admission | Actual active turn, pending permission/question, Task descendant and compaction barriers; assignment/confirmed repair denied, release through real reply APIs; live independent-backend conflicts. | Executed |
| M10.7 Malicious Replay/Resume | Real HTTP metadata/repair attacks and stopped/restarted disk-SQLite backend; persisted A authority and prior history survive and successful SDK continuation returns its response. | Executed |
| M10.8 Session-Only Utility Source Injection | Named real source-bound enhancement/branch/title/memory/compaction callers, operation prohibition checks, synthetic/missing/cross-project/stale authority and HTTP DTO rejection. Private automatic callers are exercised via their real owning pipeline, not exposed through invented APIs. | Executed |
| M10.9 Standalone Utility Context Injection | Actual utility HTTP strict-DTO attacks, CLI boundaries, commit/enhancement and Agent/roll-call real dispatch. Agent typed excess properties grant no authority; strict HTTP schemas remain distinct. | Executed |
| M10.10 Prepare/Generate TOCTOU | Actual same prepared account/model across defaults/config/credentials mutation; unavailable captured model/account and provider acquisition failures fail closed without reselection. | Executed |
| M10.11 Native Runtime Safety | Profile-backed real normal/compaction SDK paths under native opt-in, zero native compaction invocations, native/profile authority controls and real non-profile native positive cassettes. | Executed |
| M10.12 Usage Isolation and Failure Cases | Revision/account-keyed usage cache, refresh/deletion, profile usage API failures and non-profile usage controls. | PASS retained |
| M10.13 Secret Leakage Campaign | Actual hostile session HTTP/persistence/live events/replay/export, terminal/offline logs, PostHog completion, configured OTLP log/trace batches, actual standalone SDK failures and Agent/roll-call stdout/stderr controls. Intentional transcript content is retained. | Executed reachable sink inventory |
| M10.14 Failure Model Semantics | Actual normal session, enhancement/commit and Agent/roll-call authorization/quota/malformed/timeout/DNS/cause/refresh failures; static profile errors, retry/quota distinction and no substitute account. Memory failure ports separately identified as ports. | Executed |
| M10.15 Fault-Injection Qualification Seams | Existing real SDK HTTP interception, typed/log boundary controls, parser faults, observational acquisition tap and reply/transport barriers. No new provider/account/telemetry architecture. | Executed |
| M10.16 Cross-Process Matrix | Independent real backend route conflicts, refresh/credential revision/deletion children, real SQLite locks and restarted session resume; no shared in-memory mutex substitute. | Executed |
| M10.17 Client Boundary Matrix | Current VS Code/JetBrains utility/account, stale reconnect, prepared identity, choice cancellation and compatible/unsupported DTO cases pass. Deployed historical application versions are not provisioned. | Current source executed; historical deployment NOT RUN |

### Remaining NOT RUN

- **M10.17 historical deployed VS Code/JetBrains applications/binaries:** unavailable external client environment. Archived source/database history tests and current-source fake/API seams are not deployed application execution. Completing that mandatory historical-client evidence requires provisioned versioned clients and their integration environment; no retry, timer or source-only test can create the missing evidence.
- **Windows/macOS:** excluded by the user's renewed scope, not PASS and not outstanding Linux work.
- **AI SDK `ai.*`/`gen_ai.*` spans:** not a reachable enabled sink in the production telemetry configuration, not silently counted as exporter PASS. Existing configured production log/trace exports were captured; no artificial telemetry framework was introduced.

No additional concrete Linux-executable case from the independent audit remains unrun. This does not turn missing external client evidence into PASS. Rendered IDE-dialog automation and real external browser authorization were not claimed by current source/API-seam tests. M11 historical binary/platform/crash limits remain their prior record and are not expanded by this closure.

### Final Validation and Repository

The full qualification command above was rerun after strengthening diagnostic exclusion to include the **actual stored rotating refresh token**, not only hostile response markers: **137 passed /0 failed /1,375 assertions /38 files**. Its prior 1,374-assertion checkpoint remains history. The original unchanged broad aggregate after the first expanded run passed **816 passed /1 skipped /0 failed /2,002 assertions /19 files**; the final ordering rerun after the 1,375-assertion run completed with **the identical 816/1/0/2,002/19 result** (89.30 seconds). No unexplained failure is accepted as a pass.

Core remains **119/590/12 files**, current VS Code complete unit suite **6,709 passed /24 skipped /0 failed /40,567 assertions**, targeted VS Code utility/account **62/126** plus commit **14/23**, JetBrains backend **26** and frontend **16** relevant tests. Exact commands and fixture limitations appear above. Root/package typechecks, Prettier, root lint and local guards are green with the counts in the latest checkpoint. The inherited task-nesting failure remains separately baseline-proven, not hidden or fixed outside scope.

Final inventory: **18 modified tracked files +49 untracked files =67**, all unstaged. HEAD is `2547dd8f908a8dfcd16d0d3396b46933720f52db`; branch is `feat/provider-account-profiles`; index is empty. No commits or pushes, no M12, no cache deletions and no new architecture. Existing concurrent qualification work was preserved. The additional confirmed production defects in direct enhancement and Agent diagnostics are corrected and have real caller regressions; previously accepted session/offline/quota fixes remain intact.

The executable Linux corrective campaign is complete, but the strict whole-M10 disposition cannot be PASS while mandatory historical deployed-client execution remains NOT RUN. This is an external evidence requirement, not an unresolved aggregate defect or an architectural redesign recommendation.

**M10 FAIL — CORRECTIVE WORK REQUIRED**

## Hosted Qualification Plan

Workflow: `.github/workflows/provider-account-qualification.yml`. Triggers: manual `workflow_dispatch` and explicit pushes of tags matching `provider-account-qualification-*` only. Permissions: `contents: read`; no write permission, fork-specific runner, normal-CI change or automatic acceptance. This campaign collects evidence without changing production authentication or Provider Account architecture. **M10 FAIL — CORRECTIVE WORK REQUIRED** and **M11 NOT ACCEPTED** remain unchanged. M12 is not begun.

GitHub requires the workflow to exist on the default branch before it can receive `workflow_dispatch` events. While this workflow is feature-branch-only, bootstrap qualification with an explicitly operator-created and pushed tag in the dedicated `provider-account-qualification-*` namespace. Creating and pushing such a tag is an intentional operator action that starts a run against the exact commit referenced by the tag via `${{ github.sha }}`. Ordinary branch pushes do not run hosted qualification. Manual dispatch remains available once GitHub can register the workflow from the default branch. No qualification tag has been created or pushed as part of this trigger change.

> The hosted workflow implementation has not yet executed on GitHub Actions. Workflow code and local validation are not hosted qualification evidence.

### Current Platform Campaign

| Runner | Intended architecture | Work |
|---|---|---|
| `ubuntu-24.04` | x64 | Portable/current subset, current client boundaries, full Linux qualification and broader JetBrains tests/typecheck |
| `windows-2025` | x64 | Portable/current subset, supported client boundaries, focused JetBrains tests/typecheck via direct `gradlew.bat` with real exit status |
| `macos-15` | ARM64 | Portable/current subset, supported client boundaries, focused JetBrains tests/typecheck |

All intended hosted executions currently have status `NOT_RUN`. Actual `runner.os` and `runner.arch`, runtime architecture and image metadata are recorded by the evidence runner. ARM64 macOS does not establish Intel macOS coverage. Linux-only archive, POSIX permission and process fixtures are not reported as portable coverage. A rejected hosted runner label is infrastructure failure, not an excuse to silently use Blacksmith.

Bounded jobs: `current-platform`, `linux-full`, `jetbrains-current`, `historical-audit`, `historical-protocol`, `historical-vscode`, `historical-jetbrains`, `historical-cli-skew`, `migration-crash`. `aggregate` depends on every evidence-producing job and runs with `if: always()`. Expected executable failures fail their jobs after evidence is saved. Known unsupported historical cases emit `NOT_RUN` rather than a manufactured pass. Aggregation preserves failures, missing artifacts, platform identity and evidence classes; it cannot accept M10/M11 automatically.

### Historical Sources And Toolchains

The audit checked each pinned manifest and CLI source. Source availability is distinct from build, executable availability and compatibility. No historical CLI builds were executed locally by the audit. The CLI audit provisions an isolated exact-SHA checkout with independent Git metadata and a read-only shared object store, so Git-aware builds are not blocked merely by archive extraction. It verifies the checkout SHA and actual Bun version against the pin before building. This does not rerun or supersede the historical GUI archive failures. Each hosted audit artifact records exactly one observed availability result per checkpoint, with separate build commands, version execution and backend health outcome. The following runtime/build executions remain `NOT_RUN` before the first hosted campaign; source inspection does not promote them to executable evidence.

| Checkpoint | Source SHA | Manifest Bun | Local availability evidence | Hosted runtime status |
|---|---|---|---|---|
| Pre-profile | `76bcfd40be616a72f4697b3041565f322245b462` | `1.3.14` | `SOURCE_INSPECTION` | `NOT_RUN` |
| M1 | `7c264af09b44d6af218119de464effca1428b215` | `1.3.14` | `SOURCE_INSPECTION` | `NOT_RUN` |
| M2-M6 | `72732985186da5a19c8febcb5bef3543541128b8` | `1.3.14` | `SOURCE_INSPECTION` | `NOT_RUN` |
| M7 | `b20e2688f036703317cf87af35c6a32a2f3d9cd0` | `1.3.14` | `SOURCE_INSPECTION` | `NOT_RUN` |
| M8-M9 | `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12` | `1.3.14` | `SOURCE_INSPECTION` | `NOT_RUN` |
| M9.5 | `f2ad10f5c6c67052940bf19f14ceacf28add6b9d` | `1.4.2` | `SOURCE_INSPECTION` | `NOT_RUN` |
| Qualification checkpoint | `58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b` | `1.4.2` | `SOURCE_INSPECTION` | `NOT_RUN` |

Historical Node/Java/Gradle/extension toolchain requirements are not inferred from current tooling. Discovered historical manifests/wrappers and actual runner runtime versions are recorded separately. A successful historical build is only `HISTORICAL_REBUILT`; an actual version/backend smoke is executable availability, not a claim that historical client/backend compatibility passed.

### Established Protocol And Execution Gaps

- **M8-M9 local `PASS`, `REAL_HTTP_HISTORICAL_PROTOCOL`:** pinned source at `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12`, file hashes and source locations establish exact historical request shapes. Those requests reached the real current `Server.listen` with profiles enabled and failed closed before generation/fallback. This is not `HISTORICAL_EXECUTABLE`. The corresponding hosted run remains `NOT_RUN` until executed.
- **Historical CLI -> current backend, `NOT_RUN`:** CLI owns an embedded backend and exposes no supported external-backend skew seam. Invoking an old self-hosting command does not test external HTTP skew.
- **Current CLI -> historical backend, `NOT_RUN`:** the same embedded-server limitation applies in reverse. Product CLI architecture is not modified to manufacture a qualification seam.
- **Abrupt migration kill/restart, `NOT_RUN`:** no deterministic abrupt-termination barrier exists inside the migration transaction. No production hook, arbitrary sleep/kill or exception-as-process-termination claim is added. Existing restart/idempotence/transaction evidence remains separately valid.
- **Historical VS Code, `SOURCE_INSPECTION`, desktop flow `NOT_RUN`:** `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12`, version 7.8.3. Archived `bun run compile` exited 1 because Git metadata was absent. Historical provider-account helper tests passed, but no built VSIX or provider-account desktop execution under `@vscode/test-electron` was established. CLI source-wrapper fallback is not a compiled binary. The manual job records the gap; it does not rerun a nonexistent executable path.
- **Historical JetBrains, `SOURCE_INSPECTION`, desktop flow `NOT_RUN`:** `f2ad10f5c6c67052940bf19f14ceacf28add6b9d`, version 7.8.3. Archived `buildPlugin` and focused account-context tests exited 1 at Gradle configuration because Git metadata was absent. No provider-account desktop-flow tests or executable compatibility result were established. The manual job records the gap rather than equating a Gradle build with client/backend compatibility.

### Artifact And Security Contract

The only evidence classes are `CURRENT_EXECUTABLE`, `HISTORICAL_EXECUTABLE`, `HISTORICAL_REBUILT`, `REAL_HTTP_HISTORICAL_PROTOCOL`, `PROTOCOL_FIXTURE`, `SOURCE_INSPECTION`, `NOT_RUN`. Each JSON document includes the actual checked-out SHA (expected `${{ github.sha }}`), workflow run ID/attempt, timestamp, safe runner metadata and structured items. Historical source commit is a separate field. Wrong-commit artifacts are rejected or explicitly failed during aggregation.

Deterministic non-secret artifact names distinguish tier/platform and run attempt. Per-job artifacts contain sanitized `evidence.json` documents only; the central `provider-account-qualification-summary` contains aggregate evidence, job outcomes and incomplete/failure reasons. Raw stdout/stderr, environment dumps, OAuth values, Authorization headers, auth JSON, SQLite stores and raw JUnit failure payloads are not uploaded. Captured output is internal to status/count extraction. Child processes receive an explicit environment allowlist and isolated HOME/XDG/AppData paths. Serialization rejects credential/output fields and redacts known synthetic secret-value patterns before writing JSON.

Local script tests, typechecks, formatting, YAML parsing and repository guards validate the implementation, not the hosted campaign. GitHub Actions semantic validation and actual Linux/Windows/macOS execution remain pending the first hosted run.

### Local Infrastructure Validation

- `bun test ./script/kilocode/provider-account-qualification --timeout 60000`: **21 passed, 0 failed, 254 assertions, 7 files**. Includes the real current HTTP historical-protocol test, both CLI skew gaps, migration gap, sanitization, capture timeout/failure, missing-artifact summary, suite/count selection, historical unavailable-source handling and YAML/workflow structure assertions. Temporary test artifacts are removed and are not hosted campaign evidence.
- `bun test ./script/kilocode/provider-account-qualification/skew.test.ts ./script/kilocode/provider-account-qualification/crash.test.ts --timeout 60000`: **3 passed, 0 failed, 8 assertions**. These cases are also included in the full infrastructure run, not additional independent campaign coverage.
- `node_modules/.bin/tsgo --ignoreConfig --noEmit --target esnext --module preserve --moduleResolution bundler --types bun --skipLibCheck --strict script/kilocode/provider-account-qualification/*.ts`: passed; bounded check of the actual scripts/tests rather than an unrelated monorepo rebuild.
- Scoped `oxlint --quiet script/kilocode/provider-account-qualification script/check-workflows.ts`: zero errors; 18 non-blocking warnings from assertion/type-narrowing lint rules remain. No guard was weakened.
- Prettier check for the new workflow, allowlist and qualification scripts: passed. The existing Markdown padding guard passed.
- `bun run script/check-opencode-annotations.ts --worktree`: passed. `bun run script/check-workflows.ts`: passed, 34 allowed workflows. YAML parses with the existing Bun YAML parser; focused tests verify manual trigger, read-only permissions, runner matrices, pinned sources, checkout SHA binding, gap jobs and always-run aggregation/uploads.
- `git diff --check`: passed. Normal CI workflows and all production files are unchanged; the allowlist has only the deliberate new-workflow entry. Changes remain unstaged/uncommitted on `feat/provider-account-profiles` at `58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b`, with the remote branch observed at the same SHA.

No local Actions semantic validator is installed. **GitHub Actions semantic validation pending first hosted run.** This validation does not accept M10/M11 or begin M12.

## Hosted Qualification Run 1

This appended record supersedes the earlier pre-run hosted `NOT_RUN` statements only for the executions explicitly recorded below. Earlier local qualification history and failures remain intact. The downloaded Run 1 JSON documents are immutable; later diagnostic tooling and local reproduction do not rewrite or replace them.

- Run: [`37505370416`](https://github.com/Shardbyte/kilocode/actions/runs/37505370416), attempt **1**, repository `Shardbyte/kilocode`.
- Event: `push`; ref: `refs/tags/provider-account-qualification-0c2be33`; tag: `provider-account-qualification-0c2be33`.
- Qualification/checked-out SHA: `0c2be33f04712523e8f524a585f9e0e849eedd2f`. Local tag and remote tag both resolve to this commit. The origin branch `feat/provider-account-profiles` also remains at that SHA.
- Created/started: `2026-10-06T17:40:30Z`; last job completed: `2026-10-06T17:59:07Z`; run terminal update: `2026-10-06T17:59:08Z`. Status: `completed`; conclusion: `failure`.
- All **20 jobs** finished naturally: **9 success, 11 failure**. No cancellation, rerun, retry, dispatch, second tag, branch push or product fix occurred during Run 1 review.
- All **16 evidence artifacts** were downloaded and inspected, including `provider-account-qualification-summary/aggregate.json`, under `/tmp/kilo/provider-account-run-37505370416-attempt-1/`. Each document binds the checked-out SHA, run ID, attempt and runner OS/architecture. No historical-audit artifacts were published.
- Aggregate: **63 items: 41 PASS, 13 FAIL, 9 NOT_RUN**; `status: FAIL`; `qualificationAccepted: false`. The aggregate job failed at `Aggregate evidence` after saving and uploading the summary. This is failure propagation, not absence of an aggregate artifact.

### Current Platform Results

All rows below retain `CURRENT_EXECUTABLE`. Test counts are not proof of failed-test identity or cause.

| Job / Item | runner.os / runner.arch | Run 1 Result | Executed Counts / Limit |
|---|---|---|---|
| Current portable and clients (linux): portable | Linux / X64 | PASS | Core 17, authority 17, schemas 4, SDK 4; zero failures |
| Current portable and clients (windows): portable | Windows / X64 | PASS | Core 17, authority 17, schemas 4, SDK 4; zero failures |
| Current portable and clients (macos): portable | macOS / ARM64 | PASS | Core 17, authority 17, schemas 4, SDK 4; zero failures; not Intel macOS coverage |
| `clients:linux:vscode` | Linux / X64 | PASS | 267 passed, 0 failed, 1 skipped, 565 assertions |
| `clients:windows:vscode` | Windows / X64 | FAIL | 264 passed, 2 failed, 0 skipped, 561 assertions; exact failed names absent from Run 1 artifact; attribution UNRESOLVED |
| `clients:macos:vscode` | macOS / ARM64 | FAIL | 266 passed, 1 failed, 1 skipped, 564 assertions; exact failed name absent from Run 1 artifact; attribution UNRESOLVED |
| Current client package typechecks | All three OS legs | PASS | OpenCode, core, SDK and VS Code typechecks pass on each OS |
| `clients:windows:windows-worktree` | Windows / X64 | PASS | Existing process-lock regression: 1 passed, 6 assertions |
| `clients:macos:darwin-profile` | macOS / ARM64 | PASS | Existing Darwin policy: 3 passed, 28 assertions; excluded tests are not claimed executed |
| `linux-full:linux:qualification` | Linux / X64 | FAIL | 135 passed, 2 failed, 0 skipped, 1,364 assertions; exact failed names absent from Run 1 artifact; attribution UNRESOLVED |
| `linux-full:linux:core-full` | Linux / X64 | PASS | History/migration/process group: 119 passed, 590 assertions |
| `linux-full:linux:aggregate` | Linux / X64 | PASS | Prior single-process regression group: 816 passed, 0 failed, 1 skipped, 2,002 assertions; no retry |
| `linux-full:linux:sdk-full` | Linux / X64 | PASS | 23 passed, 37 assertions |
| `linux-full:linux:sdk-types`, `linux-full:linux:backend-types` | Linux / X64 | PASS | Both typechecks pass |
| Current JetBrains (linux) | Linux / X64 | PASS | Full runner 5,527 passed, zero failures/skips; Java 21 Gradle typecheck passes |
| Current JetBrains (windows) | Windows / X64 | PASS | Focused boundary group 42 passed, zero failures/skips; Java 21 Gradle typecheck passes |
| Current JetBrains (macos) | macOS / ARM64 | PASS | Focused boundary group 42 passed, zero failures/skips; Java 21 Gradle typecheck passes |

The Windows/macOS jobs failed at `Record client qualification`; Linux full failed at `Run Linux qualification`. These three current executable failures are not classified as product, platform, harness or flaky defects from counts alone. Local Linux diagnostics below are separate evidence; Windows/macOS are not emulated locally.

### Historical Inspection Failures

All seven `historical-audit` matrix legs ran on Linux / X64 and failed at `Inspect pinned historical source and toolchain`. The visible helper diagnostic was only `Error`; the build/runtime phase did not start and no availability artifacts were produced. This is an M11 qualification-infrastructure failure with **undetermined availability**, not seven demonstrated unavailable or source-only checkpoints.

| Checkpoint | Pinned SHA | Run 1 Status / Evidence |
|---|---|---|
| Pre-profile | `76bcfd40be616a72f4697b3041565f322245b462` | Inspection job FAIL; availability unknown |
| M1 | `7c264af09b44d6af218119de464effca1428b215` | Inspection job FAIL; availability unknown |
| M2-M6 | `72732985186da5a19c8febcb5bef3543541128b8` | Inspection job FAIL; availability unknown |
| M7 | `b20e2688f036703317cf87af35c6a32a2f3d9cd0` | Inspection job FAIL; availability unknown |
| M8-M9 | `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12` | Inspection job FAIL; availability unknown |
| M9.5 | `f2ad10f5c6c67052940bf19f14ceacf28add6b9d` | Inspection job FAIL; availability unknown |
| Qualification checkpoint | `58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b` | Inspection job FAIL; availability unknown |

Run 1's aggregate records seven `missing:history:<checkpoint>` FAIL items with evidence `SOURCE_INSPECTION`. These are missing-artifact sentinels, not availability classifications or historical execution evidence. It also records three FAIL job summaries (`job:linux-full`, `job:current-platform`, `job:historical-audit`) with `SOURCE_INSPECTION`. Together with the three `CURRENT_EXECUTABLE` failures, these account for all 13 FAIL items without conflating item counts and failed jobs.

### Protocol And Retained Gaps

`historical-protocol:source` is PASS / `SOURCE_INSPECTION`; `historical-protocol:http` is PASS / `REAL_HTTP_HISTORICAL_PROTOCOL`. Pinned M8-M9 source establishes commit-message path/language and enhancement text-only request shapes. Those shapes were sent to the real current HTTP server with profiles enabled and both failed closed before generation/fallback. This is not execution of a historical client application. `historical-cli-skew:remote-target-audit` is PASS / `SOURCE_INSPECTION` and establishes the embedded-backend limitation only.

All nine retained gaps are **NOT_RUN / NOT_RUN**, even though the jobs recording them succeeded:

| Exact Item | Retained Reason |
|---|---|
| `historical-vscode:build` | Historical archive build failed without Git metadata; no hosted build or rebuilt VSIX established |
| `historical-vscode:accountTests` | Local helper tests do not establish hosted helper or desktop-flow execution |
| `historical-vscode:guiFlow` | No historical provider-account desktop-flow executable path established |
| `historical-jetbrains:build` | Historical archive build failed without Git metadata; no hosted rebuild established |
| `historical-jetbrains:accountTests` | Local focused Gradle tests failed at configuration; hosted tests not run |
| `historical-jetbrains:guiFlow` | No historical provider-account desktop-flow executable path established |
| `historical-cli-skew:old-cli-to-current-http` | CLI owns an embedded backend; no supported external-backend skew seam |
| `historical-cli-skew:current-cli-to-old-http` | Same embedded-backend limitation in reverse |
| `migration-crash:abrupt-during-migration` | No deterministic pre-commit transaction barrier; no abrupt-kill recovery assertion performed |

### Safety And Disposition

Run 1 evidence JSON inspection found no unsafe credential/output fields or known synthetic credential markers. Captured child stdout/stderr, assertion values, stacks, provider errors, headers, OAuth values, auth stores and databases were not uploaded as evidence. Raw logs used for later diagnosis remain private under `/tmp/kilo`; only safe structured metadata may enter this ledger or an artifact. A bounded marker scan is not a general proof that arbitrary secrets can be recognized.

The Run 1 campaign and review left the repository clean with empty index at `0c2be33f04712523e8f524a585f9e0e849eedd2f`, branch `feat/provider-account-profiles`; origin matched. The only new Git ref was the one explicitly authorized qualification tag. Later authorized diagnostic-infrastructure changes are unstaged/uncommitted and do not alter this execution record.

**M10 FAIL — CORRECTIVE WORK REQUIRED**

**M11 NOT ACCEPTED**

No milestone acceptance, product correction or M12 is authorized by this record. The three current failures require exact identities and evidence-based attribution before any new M10 disposition is considered.

### Authorized Diagnostic Closure

The following work is separate from immutable Run 1 evidence. Only qualification tooling, qualification tests, the workflow's evidence plumbing and this ledger are changed. Changes remain unstaged/uncommitted for human review. No product, authentication or account-routing behavior is corrected, and no hosted rerun or further qualification tag is authorized.

Local Linux reproduction used the selected `qualification` suite definition, Bun **1.4.2**, the qualification capture/environment allowlist and the same suite overrides (`KILO_EXPERIMENTAL_DISABLE_FILEWATCHER=true`, empty `KILO_TEST_PROFILE`, `TURBO_FORCE=true`, `GRADLE_OPTS=-Dorg.gradle.daemon=false`). Local OS/kernel: Linux **6.12.107**, x86_64; Git **2.47.3**. This is not the hosted Ubuntu image, and CI/GitHub Actions variables were absent. Both the initial full-tier local attempt and later isolated qualification invocation recorded **136 passed, 1 failed, 0 skipped**, exit **1**, no suite timeout, versus hosted **135 passed, 2 failed**. This divergence does not establish either hosted identity.

The one source-validated local failed identity is:

- File: `packages/opencode/test/kilocode/qualification/caller-failures.test.ts`.
- Top-level test: `Agent.generate and roll-call fail safely for real SDK errors and captured production output` (no enclosing `describe`).
- Safe category: `assertion-failure`; attribution: **UNRESOLVED**.
- Assertion location: line **79**, instrumented AppRuntime invocation-count check. The child-process status and preceding matrix assertions passed. The instrumentation is in `caller-failures.fixture.ts:41-50`. Counts/diagnostic text do not establish product versus fixture/runtime cause. No assertion actual/expected values, child output or exception messages are recorded here.

An unvalidated utility-authority diagnostic is not counted as a second failed test identity. The initial local attempt selected the whole `linux-full` tier rather than only its failed qualification suite; its repeated core/aggregate/SDK successes and typechecks are not replacement campaign evidence. The subsequent invocation selected only `qualification`; no product/test failure was fixed.

Read-only GitHub API downloads of the Windows and macOS job logs succeeded. Both logs retain `vscode: FAIL` and successful portable execution/artifact upload, but neither contains captured Bun child output, failed-test names or test counts. Counts remain those in the immutable evidence JSON: Windows **264 passed, 2 failed**; macOS ARM64 **266 passed, 1 failed, 1 skipped**. Both attributions remain **UNRESOLVED**, with failure identities unknown and safe diagnostic category `unknown-safe`. Neither OS was emulated locally. The new parser can provide safe identities on a future reviewed execution; it cannot recover output that Run 1 never published.

`run.ts` now recognizes Bun test-file headers and failure records with LF/CRLF and normalized path separators. Files must resolve inside the checkout (including realpath/symlink containment); a Windows absolute header on a non-Windows host is not mapped by filename guess. Test names must match static source titles and pass bounded safety checks; unsafe names are omitted. Each emitted `failedTests` record contains only repository-relative file, optional safe name and a stable category. Format drift yields no invented names; counts remain independent. Timeout/setup/process failures retain safe status metadata; assertion categories depend on recognized assertion syntax, not failure totals. Categories are reset between test records.

Security fixtures capture a real failing Bun subprocess with synthetic credential-like assertion values and an unsafe title, then inject hostile error, stack, stdout and stderr content. Serialized evidence preserves safe identity/category metadata only. Additional cases cover email/URL/home-path/overlong/static secret titles, nonexistent files, unrelated Windows absolute paths and malformed failure formats. The existing save-time artifact sanitizer remains authoritative and unchanged. Toolchain metadata is additionally restricted to bounded release-version formats rather than arbitrary subprocess output. Raw diagnostic captures remain under `/tmp/kilo` with restrictive permissions and are not uploaded, printed or committed.

Historical inspection now publishes the expected `history:<checkpoint>` FAIL / `SOURCE_INSPECTION` artifact with a stable operation reason, before exiting nonzero. All ten outcomes are exercised through the real helper with temporary Git/process fault fixtures: `checkpoint-unavailable` (NOT_RUN / NOT_RUN), `git-probe-failed`, `clone-failed`, `checkout-failed`, `revision-mismatch`, `manifest-read-failed`, `toolchain-mismatch`, `source-corrupted`, `output-write-failed` and `unexpected-inspection-failure`. Successful inspection records `INSPECTED` and continues the existing availability audit; no compatibility claim is added. The workflow supplies the artifact destination and requires successful inspection plus a nonempty Bun version before toolchain setup/runtime audit. Upload still runs after inspection failure. Aggregation consumes a real failed history item even when an expected job reports success, without appending `missing:history:<checkpoint>`.

If the publication destination itself cannot be written or evidence cannot be bound to the checkout, the helper cannot fabricate an artifact. It emits only the stable publication failure code; a missing-artifact sentinel is then legitimate. A dedicated CLI test verifies this exception without exposing filesystem error messages or stacks. The current runner also masks unexpected CLI exceptions with a fixed failure code. Per-test categories are based on individual observed records; a later suite/process timeout does not relabel earlier assertion failures. Nested static `describe`/test titles can retain full safe names. Structured-payload/control-character titles are omitted before the unchanged final sanitizer.

All seven private Run 1 historical logs contain only the generic `Error`, without an internal stack/source line. In a fresh full-history shared clone detached at the exact qualification SHA, the original inspection command failed once and succeeded on a subsequent local attempt. The detached checkout, a subsequent Git probe and diagnostic inspection succeeded. These observations do **not** identify the first failing internal operation and do **not** establish a flaky-test or platform-defect classification. Local Git was **2.47.3**; hosted inspection logs report **2.55.0**. Original historical failure attribution remains **UNRESOLVED**; no availability classification is backfilled into Run 1.

Diagnostic-infrastructure validation (local worktree, not replacement hosted qualification):

- `bun test ./script/kilocode/provider-account-qualification --timeout 60000`: **37 PASS, 0 FAIL, 0 SKIP, 400 assertions**. Raw runner output is private under `/tmp/kilo/run1-diagnostic-validation/`.
- Bounded `tsgo --ignoreConfig --noEmit --target esnext --module preserve --moduleResolution bundler --types bun --skipLibCheck --strict script/kilocode/provider-account-qualification/*.ts`: **PASS**.
- Scoped `oxlint --quiet script/kilocode/provider-account-qualification`: **0 errors, 23 warnings**; no product-source lint changes.
- Prettier check of the qualification tooling directory and workflow: **PASS**.

These results validate diagnostic safety/semantics only. They do not correct the three current executable failures, establish historical availability/compatibility, remove retained NOT_RUN gaps, accept M10/M11 or begin M12.

The bounded Git-version-matched follow-up could not execute: Git **2.55.0** is not preinstalled, and this environment lacks `make` and a C compiler needed to build the official release. No release download, build, global installation or Git configuration change was performed. Consequently, no matched-version command result or first deterministic internal failure operation is established. Historical inspection root cause remains **UNRESOLVED**, rather than a guessed Git/platform defect. Diagnostic infrastructure is ready for human review; original failure attribution is explicitly incomplete. No hosted rerun or further qualification tag was created.

Final local guards pass: workflow allowlist (**34 workflows**), OpenCode annotation check, markdown table padding (**372 files**) and `git diff --check`. HEAD, origin branch and the authorized tag remain `0c2be33f04712523e8f524a585f9e0e849eedd2f`; branch remains `feat/provider-account-profiles`. The index is empty; the worktree contains only the nine authorized diagnostic/workflow/test/plan modifications. No commits or pushes were made during diagnostic closure.

## Run 2 Targeted Attribution

This append-only record does not rewrite either campaign aggregate. Run 2 is `37552045709`, attempt **1**, qualification SHA `31bd901b96f349373a521e3bc2c958adc2f93c9c`: **40 PASS, 15 FAIL, 9 NOT_RUN**, **64 items**, `qualificationAccepted: false`. All 20 jobs completed naturally. Run 1 remains `37505370416`, SHA `0c2be33f04712523e8f524a585f9e0e849eedd2f`: **41 PASS, 13 FAIL, 9 NOT_RUN**. M10 remains **FAIL - CORRECTIVE WORK REQUIRED** and M11 **NOT ACCEPTED**; M12 is not begun.

The user authorized targeted diagnostic tests, qualification-only helpers, checkout-harness diagnosis and this evidence-plan append. The user separately approved publishing a diagnostic-only branch and dispatching its targeted jobs. No product correction, assertion correction, authentication/routing/fallback change, full third campaign, qualification tag or PR is authorized or performed.

### Immutable Run 2 Results

| Surface | Run 1 | Run 2 |
|---|---|---|
| Windows VS Code | 264 passed, 2 failed | 264 passed, 2 failed |
| macOS ARM64 VS Code | 266 passed, 1 failed, 1 skipped | 267 passed, 0 failed, 1 skipped |
| Linux qualification | 135 passed, 2 failed | 135 passed, 2 failed |
| macOS ARM64 JetBrains boundaries | PASS, 42 passed | FAIL, process exit 1 |
| macOS ARM64 JetBrains typecheck | PASS | FAIL, process exit 1 |
| Seven historical checkpoints | Missing-artifact failure sentinels | Published `history:<sha>` FAIL / SOURCE_INSPECTION, `checkout-failed` |

Run 1 hosted failed-test names remain unknown. Counts alone cannot establish identical failures. Run 2 independently records the GitOps apply-patch and WorktreeManager post-checkout-hook titles, the caller failure title, an unnamed utility-inference assertion diagnostic and unnamed usage/commit-message fragments. The diagnostic list is not a distinct failed-test count: file context can be lost in Bun's final failure recap. Immutable Run 2 diagnostics are retained, not rewritten or promoted into additional test identities.

macOS VS Code was not rerun for a third vote. Its change between campaigns remains a **PLATFORM_OR_ENVIRONMENT candidate**, not proof of a product defect.

### Local Linux Diagnostics

Commands below run from `packages/opencode` using Bun **1.4.2**, Linux x86_64, and the qualification `capture()` environment. No original assertion was changed.

| Command | Exit | Passed / Failed | Assertions |
|---|---|---|---|
| `bun test test/kilocode/qualification/caller-failures.test.ts` | 1 | 0 / 1 | 30 |
| `bun test test/kilocode/qualification/utility-inference.test.ts` | 0 | 14 / 0 | 111 |
| `bun test test/kilocode/qualification/usage-security-api.test.ts` | 0 | 1 / 0 | 25 |
| `bun test test/kilocode/qualification/caller-failures.test.ts test/kilocode/qualification/utility-inference.test.ts test/kilocode/qualification/usage-security-api.test.ts` | 1 | 15 / 1 | 166 |
| `bun test test/kilocode/qualification/title-caller.test.ts test/kilocode/qualification/caller-failures.test.ts` | 1 | 1 / 1 | 45 |
| `bun test test/kilocode/qualification/caller-matrix.test.ts test/kilocode/qualification/utility-inference.test.ts` | 0 | 18 / 0 | 145 |
| `bun test test/kilocode/qualification/reauth-route.test.ts test/kilocode/qualification/usage-security-api.test.ts` | 0 | 2 / 0 | 40 |
| All three predecessor/target pairs, preserving target argv order | 1 | 21 / 1 | 230 |

The sole reproduced failure is `caller-failures.test.ts:79`, an exact internal `AppRuntime.runPromise` instrumentation-total assertion. The preceding behavior, process status, matrix and leakage assertions pass. Provisional local attribution: **QUALIFICATION_HARNESS**, instrumentation-count fragility. The specific environment difference remains **UNRESOLVED**; no failing assertion is corrected.

An initial bare-Bun execution passed all three files (16 passed, zero failed), but did not match qualification capture's sanitized environment. It is a diagnostic control, not replacement campaign evidence. Varying `CI`, the file-watcher override and `TURBO_FORCE` independently did not remove the captured caller failure. Because it fails independently, a predecessor is not required for local reproduction. Utility inference and usage security pass both independently and with the selected immediate predecessors; their hosted attribution is not thereby resolved.

The earlier local captured full-suite headers supplied candidate immediate predecessors, not hosted Run 2 order. The new combined local command actually discovered caller, usage, then utility despite the argv order. The six-file local header order was title-caller, caller-failures, reauth-route, usage-security-api, caller-matrix, utility-inference. Hosted Run 2 discovery order remains unavailable; no exact hosted-order reproduction is claimed.

Provenance correction: `/tmp/kilo/linux-qualification-diagnostic/qualification.stderr.raw` belongs to an earlier **local** SHA `0c2be33f04712523e8f524a585f9e0e849eedd2f` diagnostic at `2026-10-06T18:21:47.856Z`, not hosted Run 2. An initial attribution to `utility-authority-lifecycle` from that log was unsupported and is withdrawn. New local raw captures are private under `/tmp/kilo/linux-targeted-attribution/`, directory mode `0700`, file mode `0600`; their assertion values and captured output are not reproduced here.

### Historical Checkout Reproduction

Local Git **2.47.3** used a non-shallow source checkout detached at `31bd901b96f349373a521e3bc2c958adc2f93c9c`. The exact sequence below succeeded for pre-profile `76bcfd40be616a72f4697b3041565f322245b462`, M8-M9 `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12`, and qualification checkpoint `58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b`:

```sh
git clone --shared --no-checkout <detached-full-history-source> <owned-temp-target>
git checkout -b qualification <historical-sha>
```

All clone and checkout operations exited **0**, resolved the requested commits and produced the expected HEAD with Git metadata. Normal local clones without `--shared` and detached worktrees also passed for the same three checkpoints: nine local operations total. Shared clones contained alternates; ordinary clones did not. Worktrees used normal linked Git metadata rather than an independent `.git` directory. No historical build, binary-version check, backend smoke or availability classification was run.

Strategy evaluation: shared clones depend on the source object store remaining accessible and unpruned; ordinary local clones remove the alternates dependency but may hard-link objects unless explicitly told otherwise. Worktrees share source metadata and require Git-managed removal/pruning. All expose Git metadata to build tools, but no build-tool compatibility is inferred. Managed clones and source directories were removed; managed worktrees were removed and pruned. Private temporary parents were `0700`. The production inspection strategy is not switched merely because an alternative succeeds.

The historical helper now emits bounded known-pattern codes: `checkout-ref-unresolvable`, `checkout-branch-create-failed`, `checkout-worktree-materialization-failed`, `checkout-repository-safety-failed`, or `checkout-unclassified`; clone failures retain `clone-failed`. Raw Git stderr is never serialized. Unknown checkout failure cannot establish checkpoint absence or source-only availability.

### Hosted Targeted Execution 1

The approved branch is `diagnostic/provider-account-run2-attribution`. Diagnostic commit `fd093a42da2eec3047c7bfa9f5112689faf45de1` has parent `31bd901b96f349373a521e3bc2c958adc2f93c9c` and only qualification helper/test/workflow changes. The local full-campaign workflow is unchanged. On the diagnostic branch alone, its registered path contains the disabled-template content: manual dispatch only, read-only contents permission, exactly Windows, macOS and historical-Git jobs. There is no push/tag trigger or full-suite job.

Run **37557444919**, attempt **1**, event `workflow_dispatch`, started `2026-10-07T01:30:31Z` and reached terminal metadata at `2026-10-07T01:38:00Z`. All three jobs completed naturally with failure and uploaded all three safe JSON artifacts. Download location: `/tmp/kilo/provider-account-targeted-37557444919-attempt-1/`. Evidence binds the diagnostic commit and retains the original qualification SHA; it is not a third full qualification campaign.

Windows **X64**, Bun **1.4.2**, Git **2.55.0.windows.5**:

| Command from `packages/kilo-vscode` | Exit | Passed / Failed | Assertions |
|---|---|---|---|
| `bun test src/services/commit-message/__tests__/index.spec.ts --timeout 60000` | 0 | 14 / 0 | 23 |
| `bun test tests/unit/worktree-manager.test.ts --timeout 60000` | 1 | 130 / 2 | 311 |
| `bun test tests/unit/git-ops.test.ts --timeout 60000` | 1 | 53 / 1 | 87 |
| `bun test src/services/commit-message/__tests__/index.spec.ts tests/unit/worktree-manager.test.ts tests/unit/git-ops.test.ts --timeout 60000` | 1 | 197 / 3 | 421 |

The named apply-patch and hook-tolerance failures reproduce independently and together. The worktree file also has an unnamed failure. Failure recaps are duplicated and can be attached to the last file, so three unnamed commit-message fragments in the combined artifact do not establish three commit-message failures. The standalone commit-message run passes. No product-profile defect is inferred from suite membership. At this point the named Windows failures and unnamed worktree failure remain **UNRESOLVED** pending bounded Git/environment controls.

macOS **ARM64**, Java **21**, Bun **1.4.2**: both original focused Gradle boundary and typecheck commands exited **1**, no timeout, no parsed failed-test names or executed JUnit counts. The first process-stage classifier returned `unclassified`. The targeted execution did not pass, so a transient/platform conclusion cannot be promoted from Run 1's PASS. Attribution remains **UNRESOLVED**; no JetBrains product code is changed.

Ubuntu **X64**, Git **2.55.0**: the source-preparation check did not verify a detached qualification source, while confirming full history. All nine strategy items report `source-checkout-unverified`, with no individual operation executed. This is a diagnostic setup failure, not evidence that all nine historical operations failed or that any checkpoint is unavailable. A bounded source-stage probe is required before comparing strategies on the hosted runner.

### Diagnostic Follow-Up Scope

The remaining follow-up is limited to safe source-checkout facts, bounded Gradle task/stage classification, and controlled Windows Git fixture diagnostics. Git LFS attributes in this repository are a hypothesis to test against checkout materialization, not an established root cause. Any filter/config control is confined to a managed diagnostic checkout or private diagnostic HOME; it is not a production checkout-strategy or authentication change. The full Windows suite, macOS VS Code third-vote rerun and full qualification campaign remain excluded. Both immutable aggregates and all nine known GUI/CLI/crash NOT_RUN gaps remain unchanged.

Controlled local Linux import-order diagnostics subsequently executed all six permutations of caller, utility and usage with a temporary wrapper importing the actual tests in sequence. Each registered 16 tests and returned **15 passed, 1 failed, 166 assertions, exit 1**; observed headers confirmed the selected import order. The caller instrumentation-total assertion was the sole failure in every permutation. Utility inference and usage security passed in every order. The caller fixture runs in a separate child process, so these parent import permutations cannot change its internal counter. This finds no order contamination among these three targets, but does not reconstruct the unavailable hosted discovery order or resolve the second hosted failure. The wrapper was removed; private `perm-1.raw` through `perm-6.raw` captures retain mode `0600`.

### Hosted Diagnostic Follow-Ups

Two bounded diagnostic follow-ups were published only on the approved diagnostic branch, not on the milestone branch. Neither is a full qualification campaign or a campaign retry; each new diagnostic SHA received one manual dispatch, attempt 1. No raw captured child output was uploaded.

| Diagnostic Run | SHA | Scope | Result |
|---|---|---|---|
| `37559331746` | `e4f4c52094fbf304a601389e53896030c47125e4` | Windows Git controls, historical checkout stages, macOS focused boundaries/typecheck | Three job failures; two published artifacts, Windows publication failure |
| `37560012231` | `f908f0183704772b2d858f7b399f15dee7f6a91a` | Corrected Windows private-HOME setup and historical checkout materialization control | Windows/history failed, macOS explicitly skipped; both expected artifacts published |

Run `37559331746` started `2026-10-07T01:53:39Z` and terminal metadata was updated `2026-10-07T01:58:31Z`. The Windows helper attempted to stat its isolated HOME before creating it; no Windows JSON was published. This is **QUALIFICATION_HARNESS**, not an executed product result. The helper now creates its managed HOME first. Run `37560012231` started `2026-10-07T02:02:03Z`; its Windows artifact timestamp is `2026-10-07T02:08:06.754Z`. Both runs and the first targeted run remain preserved separately.

The corrected parser now clears file context at Bun's final recap/count lines. A real multi-file subprocess regression and static recap fixture verify that summaries cannot duplicate failures or attach them to the last file. This diagnostic-only correction does not rewrite either campaign artifact or change any original failing test.

#### Windows Final Controls

| Final diagnostic command/condition | Exit | Passed / Failed | Interpretation |
|---|---|---|---|
| Apply-patch full-title anchored name filter, baseline | 1 | 0 / 0 | No executed-test evidence; invalid control |
| Hook-tolerance full-title anchored name filter, baseline | 1 | 0 / 0 | No executed-test evidence; invalid control |
| Worktree file, baseline | 1 | 131 / 1 | Named hook-tolerance assertion failure |
| Apply-patch name filter, private HOME `autocrlf=false` | 1 | 0 / 0 | No executed-test evidence; invalid control |
| Hook-tolerance name filter, private HOME `autocrlf=false` | 1 | 0 / 0 | No executed-test evidence; invalid control |
| Worktree file, private HOME `autocrlf=false` | 1 | 130 / 2 | Named hook-tolerance assertion failure plus one unnamed failure |

The full-file commands are `bun test tests/unit/worktree-manager.test.ts --timeout 60000`. The name-filter commands add `--test-name-pattern` with the anchored full displayed nested title. They return no execution evidence; their empty failure categories do not prove a test assertion or identify an autocrlf cause. The isolated private Git config is restored/removed in `finally`; no real HOME or product Git configuration is changed.

GitOps apply-patch is reproducible in the first targeted file/combined execution, but the invalid filtered control cannot isolate its cause. Hook-tolerance is reproducible independently, combined, and in both final full-file conditions. The additional worktree failure varies between executions; its safe name is unavailable. Counts alone cannot attribute that variation to the config control. Commit-message passes independently; recap fragments do not prove failures in that file. Named Git/worktree failures and the additional unnamed failure remain **UNRESOLVED**, not product-profile defects. The zero-test filtered controls are **QUALIFICATION_HARNESS** diagnostic failures. No further hosted execution is performed to seek a favorable vote.

#### Historical Final Controls

Hosted Git **2.55.0** confirms a successful source clone (exit **0**), resolvable qualification commit, full history and Git metadata, with no repository-safety failure. The exact source checkout exits **128** with a bounded LFS-filter signature and fixed classification **`checkout-worktree-materialization-failed`**. A retry with filters disabled initially exited **1** after partial materialization. A subsequent forced retry confined to the owned temporary source succeeds (exit **0**), verifies HEAD at the qualification SHA and verifies detached state. The original failure remains recorded.

After that source control, the original historical sequence runs for all three requested SHAs. Each shared clone exits **0**; `git checkout -b qualification <sha>` exits **128**, with the ref resolvable, Git metadata present, alternates present and LFS failure recognized. Each ordinary local clone also exits **0** and its checkout exits **128** with the same LFS signature, despite having no alternates. Thus `--shared` is **not** demonstrated to cause the failure.

For each of the same three SHAs, a separate fresh shared-clone control uses per-command `filter.lfs.process=`, `filter.lfs.smudge=`, and `filter.lfs.required=false`; checkout exits **0**, creates the qualification branch and verifies the requested HEAD. The controlled clone still uses alternates. This establishes LFS-enabled worktree materialization as the failing stage in the sampled hosted reproduction, not branch creation, ref absence or alternates access. It does not establish the precise LFS download/authentication cause, and it is not a product or permanent harness-strategy correction. LFS pointer checkout is diagnostic source evidence, not a built historical executable.

| Sampled SHA | Shared original | Ordinary clone original | Fresh shared LFS-disabled control | Worktree alternative |
|---|---|---|---|---|
| `76bcfd40be616a72f4697b3041565f322245b462` | Clone 0, checkout 128, LFS signature | Clone 0, checkout 128, LFS signature | Clone 0, checkout 0, expected HEAD | Exit 128; no verified checkout |
| `34ceb6e9e2b35d3d5a7e2a5fa1f07be5c7529b12` | Clone 0, checkout 128, LFS signature | Clone 0, checkout 128, LFS signature | Clone 0, checkout 0, expected HEAD | Exit 128; no verified checkout |
| `58c28a4261dbe8ca4dc7f8a6455fec74a31e3e5b` | Clone 0, checkout 128, LFS signature | Clone 0, checkout 128, LFS signature | Clone 0, checkout 0, expected HEAD | Exit 128; no verified checkout |

The final historical artifact marks the strategy/control items **FAIL / SOURCE_INSPECTION**, `temporary-cleanup-failed`, because its aggregate cleanup flag failed. The separate operation fields preserve the exits and HEAD verification above. These successful control operations are not promoted to artifact PASS. Failed worktree attempts/removal are a diagnostic cleanup limitation; managed parent removal is attempted afterward, but hosted cleanup success is not claimed. No historical build tool, executable version, backend smoke or client compatibility was executed. Availability remains unknown for all seven campaign checkpoints. Provisional attribution for sampled checkout failures: **QUALIFICATION_HARNESS** / hosted LFS-materialization dependency, not historical product failure. The specific underlying LFS cause and unsampled checkpoint-specific causes remain **UNRESOLVED**.

#### macOS JetBrains Stage

The second targeted macOS ARM64 execution identifies **`openapi-generation`** for both focused tests and typecheck. Both exit **1**, with fixed allowlisted failed task names `:backend:generateOpenApiSpec` and `:backend:writeCliChecksums`, no timeout, no failed-test names, and no executed JUnit counts. These are prerequisite pipeline failures, not failing boundary assertions. The specific download/generation/checksum failure remains **UNRESOLVED**; build/platform infrastructure is a candidate, not a demonstrated transient. Run 1 PASS and Run 2 FAIL remain intact. The final two-job diagnostic explicitly skips macOS; no third JetBrains vote is taken.

### Attribution Disposition

No evidence-supported provider-profile product defect candidate is established. Local caller-count fragility and recap misattribution are qualification-harness findings; sampled historical LFS materialization is a qualification/environment finding; Windows named Git fixtures and macOS prerequisite failures retain the limits above. No product corrections have been made. All nine retained GUI/CLI/crash NOT_RUN items remain unchanged. M10 remains **FAIL - CORRECTIVE WORK REQUIRED** and M11 **NOT ACCEPTED**.

### Final Validation And Repository State

The final diagnostic run reached terminal metadata at `2026-10-07T02:08:11Z`; no additional hosted dispatch is performed. The invalid anchored Windows filters were corrected **locally only** to leaf-title matching, with a real nested Bun fixture verifying selection. That local diagnostic correction is not a hosted Windows result and is not pushed; both invalid hosted control records remain unchanged. Failed worktree cleanup remains explicitly recorded rather than silently promoted to success.

- From `packages/opencode`: `bun test ../../script/kilocode/provider-account-qualification --timeout 60000`: **51 passed, 0 failed, 566 assertions across 10 files**.
- `bunx --no-install tsgo --ignoreConfig --noEmit --target esnext --module preserve --moduleResolution bundler --types bun --skipLibCheck --strict script/kilocode/provider-account-qualification/*.ts`: **PASS**.
- `bunx --no-install oxlint --quiet script/kilocode/provider-account-qualification`: **0 errors, 26 warnings**.
- Prettier check of qualification helpers and explicit YAML parsing of the disabled template: **PASS**.
- `bun run script/check-workflows.ts`: **PASS**, 34 workflows. The diagnostic template is inert locally; the registered campaign workflow remains unchanged locally.
- `bun run script/check-opencode-annotations.ts --worktree`: **PASS**, no shared upstream source changes.
- `bun run script/check-md-table-padding.ts`: **PASS**, 372 files; `git diff --check`: **PASS**.

Validation used `PATH=/tmp/kilo/bun-tooling/node_modules/.bin:$PATH`, Bun 1.4.2. An initial root test command was rejected by the repository guard and was replaced with the package-scoped command; a diagnostic test type error was corrected before publication. No product package failure was fixed.

All seven published targeted JSON artifacts across the three diagnostic runs were downloaded and inspected. Run 2 and Run 1 evidence directories and aggregates remain untouched. Targeted JSON metadata binds the respective diagnostic SHA/run/attempt and recorded OS/architecture; directories are `0700`, files `0600`. Structural review found no raw stdout/stderr, assertion actual/expected fields, stacks, HTTP body/headers, credential/auth-store payload, environment dump or synthetic-marker values. This bounded audit does not guarantee arbitrary secret recognition. The missing Windows artifact in the middle diagnostic remains a documented publication failure, not fabricated evidence.

Branch remains `feat/provider-account-profiles`. Local HEAD, origin tracking branch and remote milestone branch remain `31bd901b96f349373a521e3bc2c958adc2f93c9c`; the regular index is empty. Only the approved diagnostic branch was committed/pushed, ending at `f908f0183704772b2d858f7b399f15dee7f6a91a`; its three commits are diagnostic-only. The evidence-plan append and local qualification helpers remain working-tree changes for review. There are no changes under `packages/` or to the local registered full-campaign workflow. Exactly the two original qualification tags remain unchanged locally/remotely: `provider-account-qualification-0c2be33` and `provider-account-qualification-31bd901`. No full campaign tag, product changes, authentication/routing/fallback changes, PR, acceptance or M12 work occurred.

## Phase 1 Historical LFS Dependency Audit

The read-only audit covered all seven allowlisted historical checkpoints using Git trees, `git check-attr --source=<sha>` and committed pointer blobs. No checkout, install, build, test, LFS download or hosted execution was performed. Start/end SHA-256 fingerprints of all twelve dirty files matched; the canonical branch, HEAD, index and diagnostic reference were unchanged.

All checkpoints have identical LFS attributes: `*.gif`, `*.mp4`, the UI/VS Code test PNG patterns and the docs screenshot PNG pattern. Actual matches consist only of five MP4 outputs under `artifacts/glm52-rise-video/out/`, three GIFs under `packages/kilo-docs/public/`, and docs screenshot PNGs. The first five checkpoints have 461 screenshot PNGs, for 469 LFS paths; `f2ad10f5c6` and `58c28a4261` have 464, for 472 paths. Every matched Git blob is an LFS pointer. Between these groups three screenshots are added and one screenshot pointer changes; videos and GIFs are unchanged.

The install lifecycle, CLI build, bundled Console/UI dependency chain, SDK inputs, version helper, backend startup and `/global/health` do not consume these payloads. The CLI build entrypoint is the same Git blob at all seven checkpoints (`cdb9eafa392e615c582bcb38f93200a7164740b2`). Actual media consumers are the separate Remotion render package, documentation and Playwright visual baselines. Pinned Bun is 1.3.14 for the first five checkpoints and 1.4.2 for the final two. External dependency downloads, model-snapshot generation and Linux build prerequisites remain independent build requirements; suppressing LFS does not establish an offline or bit-reproducible build.

Decision: **LFS_NOT_REQUIRED_FOR_QUALIFIED_SURFACE**. This is a source-inspection-backed qualification-scope decision, not historical execution evidence. A future bounded historical checkout may retain committed pointers using command-local filter overrides. The repository would remain incomplete for docs media/visual-baseline use, but not for the audited CLI/backend availability surface. **LFS payload provenance is not established because payload bytes are intentionally not materialized.**

The qualified claim remains exact pinned source and Bun, frozen install, successful CLI/backend build, observed executable version and healthy backend startup. No checkpoint is promoted to HISTORICAL_REBUILT or HISTORICAL_EXECUTABLE by this audit. Run 1 remains **41 PASS / 13 FAIL / 9 NOT_RUN**; Run 2 remains **40 PASS / 15 FAIL / 9 NOT_RUN**. All nine NOT_RUN gaps, `qualificationAccepted: false`, M10 **FAIL - CORRECTIVE WORK REQUIRED**, M11 **NOT ACCEPTED** and M12 **NOT AUTHORIZED** remain unchanged.

## Phase 2 Canonical Harness Consolidation

This correction is qualification-only: retain the safe Bun recap/file-context correction and historical checkout classifier, apply the reviewed command-local LFS checkout policy, strengthen pre-build provenance checks, and retain focused regression tests. The `junit` helper remains private to the full runner; the targeted-only export is not retained. Counts remain independent of safe diagnostic entry counts. No original product test assertion or Provider Account behavior is changed, and immutable campaign diagnostics are not regenerated.

The historical checkout policy is limited to `git -c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false checkout -b qualification <sha>` in the owned historical clone. It does not persist configuration or suppress LFS for other commands. Committed pointer/source representation is retained; LFS payload provenance is not established. Successful checkout remains inspection only, not build/runtime availability evidence.

The seven targeted-only untracked files were removed individually from the canonical working tree after preservation verification. The disabled workflow template and four `history-targeted`/`targeted` files matched their diagnostic-branch blobs exactly. The two newer local Windows leaf-selector corrections were saved byte-for-byte as `/tmp/kilo/phase2-preserved-windows-probe.ts` and `/tmp/kilo/phase2-preserved-windows-probe.test.ts`, with matching Git blob hashes `c47345501c1df448b18dc1b16902a49a63cc30d3` and `723816bd027258fea7a38892a14db41677894414`. The diagnostic branch remains at `f908f0183704772b2d858f7b399f15dee7f6a91a`. No branch merge, broad clean/reset or diagnostic-branch mutation was performed. The registered full-campaign workflow remains unchanged.

Run 1 and Run 2 aggregates and artifacts remain immutable. No new hosted campaign, acceptance, compatibility claim, product correction or M12 work is authorized by this consolidation. The correction is left unstaged, uncommitted and unpushed for human review.

### Phase 2 Local Validation

Validation used `PATH=/tmp/kilo/bun-tooling/node_modules/.bin:$PATH`, Bun **1.4.2**. The repository forbids root `bun test`; the requested harness directory was tested from `packages/opencode` using the equivalent relative path. These are local harness regressions, not a new campaign or historical executable qualification.

- `bun test ../../script/kilocode/provider-account-qualification --timeout 60000`: **41 passed, 0 failed, 461 assertions across 7 files**. Diagnostic-only test files are intentionally excluded from the canonical harness.
- `bunx --no-install tsgo --ignoreConfig --noEmit --target esnext --module preserve --moduleResolution bundler --types bun --skipLibCheck --strict script/kilocode/provider-account-qualification/*.ts`: **PASS**. An initial check found two new fixture assertions using the wrong matcher message signature; both were corrected before the final test/typecheck passes.
- `bunx --no-install oxlint --quiet script/kilocode/provider-account-qualification`: **0 errors, 24 warnings**. The scoped warnings include Bun async-matcher/type-assertion warnings and the intentionally sanitized rethrow without the original raw diagnostic cause; they are not represented as a warning-free result.
- `bunx --no-install prettier --check script/kilocode/provider-account-qualification/history.ts script/kilocode/provider-account-qualification/history.test.ts script/kilocode/provider-account-qualification/run.ts script/kilocode/provider-account-qualification/run.test.ts`: **PASS**. Markdown remains excluded by repository policy and is checked by the table guard.
- `bun run script/check-workflows.ts`: **PASS**, 34 workflows; `bun run script/check-opencode-annotations.ts --worktree`: **PASS**, no shared upstream source changes.
- `bun run script/check-md-table-padding.ts`: **PASS**, 372 files; `git diff --check`: **PASS**.

The managed LFS regression now proves that an ordinary checkout invokes a failing filter, the command-local override does not invoke it and materializes the committed pointer, configuration bytes remain unchanged, and a later ordinary checkout still fails. Shallow and dirty historical source fixtures fail before install/build commands are recorded. The real multi-file Bun subprocess has an explicit timeout and verifies that each genuine failure is retained only once, independently of recap/count lines.

## Run 3 M10 Final Attribution And Qualification-Test Correction

This append records the reviewed Linux attribution and the separately authorized qualification-test correction on canonical parent `f24e0fdda6c52440676c5c0964ef5dfab480a913`. Earlier Run 1, Run 2 and Run 3 evidence is not rewritten. Run 3 remains `47 PASS / 7 FAIL / 9 NOT_RUN`; these local controls are not Run 4 or a new full campaign.

- Caller exact `AppRuntime.runPromise` total -> incidental instrumentation, not M10 invariant. The original assertion at `caller-failures.test.ts:79:33` expected 63; independently observed 67 includes fixture/setup/cleanup calls. Classification: **QUALIFICATION_HARNESS**.
- Utility stderr capture -> inherited logger-transport dependency. The source-attested test `commit-message utility generation failure logs the actual sanitized error line` failed at `utility-inference.test.ts:700:28` when process-global file logging was active. The sanitized production record was persisted; explicit stderr transport restored the assertion. Classification: **QUALIFICATION_HARNESS**.
- Product invariant violation -> **none demonstrated**. No Provider Account product implementation correction is made.

### Correction Rationale

The caller no longer asserts the aggregate runtime-call total or includes it in the asserted matrix type. The fixture retains that diagnostic-only field unchanged. To detect missing execution semantically, the test now asserts the exact six expected origins and exactly one result per expected origin for each caller. All original substantive checks remain: successful child exit, caller/output/access markers, 12 rows, six rows per caller, six origins, per-case request bounds, account-unavailable/closed results, 14 API failures, 20 attempts, one log control, six failure rows per caller, and absence of credential/provider markers.

The utility test retains its title and original logging assertion body. Because the logger has no reversible sink API, the parent executes this one test in a bounded child Bun process with the same package preload and an anchored test-title selector. A test-only child sentinel prevents recursive spawning; only that child calls `Log.init({ print: true })`. The parent process's logging transport is never changed. Child stdout/stderr are captured in memory, not echoed or persisted; the parent checks exit 0, exactly one pass, zero failures, and marker absence. The original child assertions still prove real production generation failure, public error `Failed to generate commit message`, one generation call, `service=commit-message`, `generation failed`, and marker absence from both captured production logging and the public error. Process termination bounds the child transport lifetime. No production logger semantics or full-suite transport are changed.

### Focused Local Validation

Linux, Bun **1.4.2**, `CI=true`, cwd `packages/opencode`. Runtime tooling was installed only under `/tmp/kilo/bun-tooling`; repository dependencies and lockfiles were not changed. All controls used a bounded subprocess and safe count summaries; no raw assertion/provider/auth/environment dumps were retained.

| Control (`bun test` arguments) | Passed | Failed | Skipped | Assertions |
|---|---|---|---|---|
| `test/kilocode/qualification/caller-failures.test.ts` | 1 | 0 | 0 | 32 |
| `test/kilocode/qualification/utility-inference.test.ts` | 14 | 0 | 0 | 103 |
| caller file, then utility file | 15 | 0 | 0 | 135 |
| utility file, then caller file | 15 | 0 | 0 | 135 |
| `test/kilocode/session-processor-network-offline.test.ts`, then utility file | 15 | 0 | 0 | 106 |
| utility file, then network-offline file | 15 | 0 | 0 | 106 |
| `test/kilocode/qualification` | 57 | 0 | 0 | 952 |
| Exact unchanged Run 3 selected Linux invocation below | 137 | 0 | 0 | 1369 |

```sh
bun test test/kilocode/qualification test/kilocode/session-authority-qualification.test.ts test/kilocode/session-profile-error.test.ts test/kilocode/session-error-logs.test.ts test/kilocode/session-processor-network-offline.test.ts test/kilocode/provider/utility-authority-lifecycle.test.ts test/kilocode/provider/utility-account.test.ts test/kilocode/utility-runtime-authority.test.ts test/kilocode/enhance-prompt-authority.test.ts test/kilocode/commit-message-authority.test.ts test/kilocode/agent-generation-authority.test.ts test/kilocode/compaction-account-authority.test.ts test/kilocode/cli/utility-account.test.ts test/kilocode/branch-name.test.ts test/kilocode/session-title-generation.test.ts test/kilocode/memory/memory-ports.test.ts test/kilocode/memory/memory-integration.test.ts test/kilocode/task-profile-order.test.ts
```

The denominator remains **137 tests** (original reproduction: 135 passed plus two failed). No selected path/title/test was removed or added, skipped, excluded, or made conditional to obtain a passing campaign selection. The child name filter executes the logging assertion body in isolation; it does not filter the parent qualification suite. Bun's parent assertion recap does not include child assertions: the utility's original 16 logging assertions still execute in the child, while eight parent assertions verify child execution and marker absence. An independent child-body control confirms **1 passed / 0 failed / 0 skipped / 16 assertions**. Caller semantic checks add three assertions and remove one incidental assertion. Therefore the changed parent assertion total is not evidence of reduced security coverage.

### Static Checks And Review State

- Affected package `bun run typecheck`: **PASS**.
- Scoped oxlint on the two changed test files: **0 errors, 2 existing unsafe JSON type-assertion warnings**.
- Prettier check on both changed test files: **PASS**.
- OpenCode annotation guard `--worktree`: **PASS**, no shared upstream source changed.
- Markdown table guard: **PASS**, 372 files; `git diff --check`: **PASS**.
- Qualification helpers, registered workflow, suite selection, production source, and caller fixture remain unchanged; helper tests are not affected.

Changed repository files are only the two qualification tests and this append-only ledger. Canonical branch/HEAD remain `feat/provider-account-profiles` / `f24e0fdda6c52440676c5c0964ef5dfab480a913`; the regular index is empty, and these changes remain unstaged, uncommitted and unpushed. No qualification tag, hosted run, Run 4, M11 diagnosis, M12 work, or PR was created.

Recommendation: **M10_READY_FOR_ACCEPTANCE_REVIEW** for this bounded correction; this is not automatic acceptance or resolution of other platform/historical/NOT_RUN evidence. Governance remains **M10 FAIL - CORRECTIVE WORK REQUIRED**, **M11 NOT ACCEPTED**, **M12 NOT AUTHORIZED** pending human review.

## Governing Human Decision — 2026-10-07

This appended section is the current governing disposition and prospectively supersedes earlier current-state labels, recommendations, and proposed follow-up in this ledger. Earlier records remain immutable historical checkpoints; nothing in them is edited or retroactively reclassified. Exact human decision: **M10 ACCEPTED / M11 NOT ACCEPTED / M12 NOT AUTHORIZED**.

### M10 Acceptance Basis

Canonical correction commit `989d187754823520591a6d22c3049788279ee759`, parent `f24e0fdda6c52440676c5c0964ef5dfab480a913`, subject `test(qualification): stabilize M10 behavioral evidence`. The commit changes qualification evidence only, not Provider Account product behavior:

- The caller defect in `packages/opencode/test/kilocode/qualification/caller-failures.test.ts` was an exact `AppRuntime.runPromise` total that included incidental fixture/setup/cleanup activity, not a frozen invariant. The correction requires all six expected failure origins and one result for every origin from each caller. All existing behavioral, failure, API-bound and leakage checks remain; the fixture count is diagnostic only.
- The utility defect in `packages/opencode/test/kilocode/qualification/utility-inference.test.ts` was inherited process-global logger transport: another test legitimately selected file logging while the assertion assumed stderr. The correction runs the original logging assertion body in an isolated, bounded child with explicit stderr transport. The parent does not mutate global logger state; original sanitization and leakage assertions remain. No production logging behavior changed.
- Full hosted Run 3 **37563665618**, source `f24e0fdda6c52440676c5c0964ef5dfab480a913`, remains exactly **47 PASS / 7 FAIL / 9 NOT_RUN**. No campaign evidence was rewritten. It established no evidence-supported Provider Account/Profile product defect; its two Linux qualification failures were subsequently attributed to the harness defects above.
- On corrected canonical source, the exact unchanged Run 3 Linux M10 selection passed locally: **137 passed /0 failed /0 skipped /1,369 parent assertions**. Selected denominator before correction: **137**; after correction: **137**. No selected test/file/title was removed, skipped or excluded.
- Bounded hosted confirmation: run **37580432028**, attempt **1**, Ubuntu 24.04 Linux X64, Bun 1.4.2; diagnostic SHA `7953ed1344a7d9d6f33adcbbed609ad8ebd91e43`, directly parented by canonical `989d187754823520591a6d22c3049788279ee759`, which is also the recorded canonical source. Result: **137 passed /0 failed /0 skipped /1,369 parent assertions**, exit 0, timeout false. The runner verifies the parent SHA, rejects source drift in canonical M10 product/test inputs, resolves the existing canonical Linux suite, and requires denominator 137, zero failures, zero skips and both corrected test titles passing. Exact selection equality was independently checked. This was bounded confirmation, not Run 4 or a full campaign retry. No retry occurred. The diagnostic branch `diagnostic/m10-linux-confirmation-989d187` is not merged into canonical.
- Hosted child evidence is provided by the passing utility parent's explicit assertions for child exit 0, one pass, zero failures and marker absence. The original child logging assertion body remains intact. An independent hosted child recap/count was not published; the 1,369 count is the parent-suite assertion recap, not a child assertion total.

Human acceptance statements (verbatim):

> M10 is accepted because all demonstrated M10 failures have either passed directly or were causally established as qualification-harness defects, corrected without product behavior changes or denominator reduction, and revalidated locally and on the same hosted Linux class that exposed them.

> Absence of an M10 product defect is not inferred solely from a green confirmation. Acceptance rests on the complete accumulated M10 evidence set, frozen architecture review, full hosted campaigns, targeted attribution, corrective review, and bounded hosted revalidation.

### M11 Remains Not Accepted

The following M11 concerns remain unresolved and do not qualify as proved product defects or a demonstrated invariant violation:

- Windows VS Code persistent failures `GitOps > applyPatch > applies changes to the working tree` and `WorktreeManager.createWorktree > retains post-checkout hook failure tolerance with parallel checkout` remain `PLATFORM_OR_ENVIRONMENT`. Root cause is **unproven**, and no Provider Account invariant connection is established.
- macOS ARM64 JetBrains: Run 1 passed; Runs 2 and 3 failed. Run 2 targeted attribution implicated prerequisite OpenAPI/checksum generation; Run 3 lacks sufficient phase detail to reuse that attribution automatically. Status remains **UNRESOLVED**.
- All seven historical checkpoints prove the requested commit, exact HEAD, non-shallow repository, Git metadata, pinned Bun, clean source and successful frozen install. All seven historical CLI builds exit 1. Classification remains `PASS / SOURCE_INSPECTION`, availability `SOURCE_ONLY`, `HISTORICAL_EXECUTABLE=0`, `HISTORICAL_REBUILT=0`; the common build-failure cause is not yet attributable from safe evidence.
- Six historical client gaps remain `NOT_RUN`: `historical-vscode:build`, `historical-vscode:accountTests`, `historical-vscode:guiFlow`, `historical-jetbrains:build`, `historical-jetbrains:accountTests`, and `historical-jetbrains:guiFlow`.
- Historical CLI skew `historical-cli-skew:old-cli-to-current-http` and `historical-cli-skew:current-cli-to-old-http` remains `NOT_RUN`; historical M8-M9 request-shape HTTP evidence remains `PASS / REAL_HTTP_HISTORICAL_PROTOCOL` but does not replace executable skew testing.
- `migration-crash:abrupt-during-migration` remains `NOT_RUN`.
- Current macOS execution evidence is ARM64 only; no Intel macOS execution has been established. Darwin profile-policy validation does not imply excluded tests executed.

These M11 limits do **not** reopen M10 absent a newly demonstrated violation of a frozen M10 invariant. The retained Windows/macOS, historical-client, skew, and migration gaps do not alter the explicit M10 acceptance.

### Authorization Boundary And Next Step

M10 acceptance is an explicit human milestone decision, not inferred automatically from CI. Current governance is **M10 ACCEPTED / M11 NOT ACCEPTED / M12 NOT AUTHORIZED**. This documentation checkpoint authorizes no M11 diagnostic execution, M12 work, upstream PR, diagnostic-branch merge, new full campaign or production change.

Recommended first bounded M11 diagnostic target: the two persistent Windows VS Code Git/worktree failures on the same hosted Windows class, with source-bound safe phase evidence to distinguish Git apply/worktree lifecycle, post-checkout hook behavior and platform/environment prerequisites. Root cause must be demonstrated rather than inferred from test titles. This is a planning recommendation only; it has not been executed.
