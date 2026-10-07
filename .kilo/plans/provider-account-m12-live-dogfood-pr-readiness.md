# M12 Live Dogfood and PR Readiness Plan

## Authority and scope

This is a planning document only. It does not authorize implementation, account use, live testing, builds, test runs, repository mutation, or a pull request. All statuses in this plan are **PENDING** until the corresponding work is separately authorized and performed.

- Canonical branch: `feat/provider-account-profiles`.
- Canonical source HEAD: `46652c358e38c34e7e5af09c8b2ca7fc684f9d37`.
- Governance: M10 **ACCEPTED**; M11 **ACCEPTED WITH DOCUMENTED COMPATIBILITY LIMITATIONS**; M12 **AUTHORIZED**.
- The [qualification/governance ledger](provider-account-m10-m11-qualification.md) records the explicit human decision. This plan neither edits nor supersedes earlier evidence. Reference records are not authorization to change implementation or history.
- Execution must be bounded by the phases and gates below. Do not install dependencies; run builds, tests, dogfood, or account flows; use real accounts; create commits/branches/tags; stage, stash, reset, rebase, or otherwise mutate Git; or open/update a PR under this plan.

M12 is a controlled, user-consented live-dogfood and readiness review, not a substitute for historical qualification or an assurance of universal client/backend compatibility. It may reveal a blocker; remediation requires separately reviewed and authorized work. Preserve all existing accepted checkpoints and published history.

## Operating principles and hard stops

1. Use only a disposable test backend and disposable workspace, plus user-controlled dedicated test accounts. The human operator supplies consent, account access, and any needed interactive authentication. Never share tokens, cookies, credential backups, or raw account material. Never use production/customer data.
2. Establish a small, explicit billable-use budget and a short wall-clock timebox before any live request. Attempt each flow at most once. No synthetic full-campaign run, retries, or repeated attempts to turn a failure into a pass. A failed or inconclusive attempt is recorded as such and stopped for review.
3. OAuth and any provider consent are explicit just-in-time human gates. No automation of consent, credential scraping, or account substitution. Stop if scope, billing, account identity, or recovery state is unclear.
4. Keep the operator's provider-login recovery path independent of the profile being deleted. Keep at least one usable profile until a replacement has been explicitly added and verified. Perform destructive actions late, only after earlier evidence is reviewed, and each under a separate just-in-time human gate. Deletion does not guarantee undo; re-adding an account may create a new profile ID, requiring explicit session repair.
5. Never edit databases, auth stores, environment credentials, or profile records to force an outcome. No automatic fallback, silent account swapping, refresh-scope change, or retry rerouting is allowed as an operational workaround.
6. M10 hard stops remain binding: account A silently becoming B; default reread/retry reroute; refresh scope changing; delete dispatch; handoff coordination; profile utility legacy fallback; credential leakage; or quota-based automatic routing. On any such observation: stop the affected flow, preserve only the safe summary/evidence, mark it FAIL, protect the accounts/backend, and request secure remediation review. This plan does not authorize fixes beyond proposing them for separately approved review.
7. Distinguish session/context selection from backend isolation. Separate workspaces/directories may share one `serve` process; directory-keyed state is isolated only where the implementation explicitly provides it, not for every service. Do not claim separate processes or account-store isolation merely from using separate contexts. Do not use an unsupported workaround to reach a remote topology: record it **NOT_RUN** and explain the scope limitation.

## Evidence and language

Use only this credential-safe evidence template. Store it in an approved secure project location; the report itself must contain no secret-bearing materials.

| Field | Record |
|---|---|
| Source | Exact source SHA observed at execution; must be the canonical SHA above or report the difference and stop pending review |
| Platform/client/backend | OS/platform; CLI or VS Code; backend scope (`local`/`remote`/`unknown`); whether process/context topology was observed or merely inferred |
| Accounts and sessions | Opaque labels `A`/`B`; opaque session IDs only; no provider email, username, account ID, or credential-derived identifier |
| Flow | Flow number, action, expected result, actual result; exactly one status: `PASS`, `FAIL`, or `NOT_RUN` |
| Invariants | Account identity retained, default semantics, session binding, quota/error routing, and any other applicable invariant; record evidence as a safe statement |
| Recovery | Whether the documented user-controlled recovery path remains available; describe action/result without credentials or store contents |
| Evidence integrity | Digest of any permitted sanitized artifact and artifact type; no raw logs or screenshots by default |

Do not record or attach emails, credential contents, access/refresh tokens, cookies, raw logs, OAuth screenshots, environment dumps, user-home paths, database files, or backups. If an artifact cannot be safely redacted and reviewed, do not collect it. For GUI walkthroughs, a user performs navigation and consent manually, narrates the safe expected/actual outcome, and supplies no credential-bearing screenshots. The planner records the sanitized summary only.

Use the exact UI terminology **“Default for new sessions”** and **“Used by this session”**. Avoid ambiguous “active,” “current,” or “fallback account” wording. A default change must not be described as changing an already-bound session.

## Ordered phases

The steps below implement the requested phases: Phase A (live dogfood preparation/flows) in steps 1-5; Phases B and C (UX and operational review) throughout those flows and step 7; Phase D (flag/release surface) in step 6; Phases E, F, and G (upstream, history, documentation) in step 7; Phase H (exit criteria) in step 8. This is execution order, not a new milestone scheme.

### 1. Preparations — PENDING

- Confirm the execution request and responsible human operator, the disposable backend/workspace, dedicated user-controlled accounts A and B, permitted clients, minimal billable budget, and explicit timebox.
- Agree on a safe account recovery path independent of the profile being exercised. Confirm that the operator can recover A without relying on deleting/re-adding it.
- Review the hard stops, evidence template, and terminology. Confirm that neither shared credentials nor credential-bearing artifacts will be transmitted or retained.
- Establish the intended topology and whether it is supportable as-is. If a remote arrangement requires an unsupported workaround, designate it NOT RUN rather than modifying runtime or storage.
- No login, OAuth flow, provider request, code change, or test begins in this phase.

**Gate 1 — plan and execution-scope review:** approve this sequence, disposable setup, accounts, clients, explicit cost/time caps, and evidence policy before any dogfood. Default coverage is one local backend, CLI plus VS Code, and one same-provider account pair; one supported remote topology is optional and separately reviewed. JetBrains or extra platforms are not an automatic new matrix.

### 2. Read-only preflight — PENDING

- Verify the current source SHA and branch read-only; if source differs from the canonical HEAD, stop and request review rather than silently qualifying another revision.
- Inspect only the approved current source/UI affordances and relevant M10/M11 records needed to scope this walkthrough. Do not research historical attribution or alter the planner-owned ledger.
- Record client/backend/context boundaries and identify which flows the selected setup can actually exercise. Treat source inspection as scope information, never live execution evidence.
- Confirm the disposable workspace/backend is empty of valuable data and that the operator, not an automation, controls account consent and destructive gates.
- Abort if the backend is not disposable, account ownership/consent is unclear, credentials would be exposed, or a required flow needs an unsupported workaround.
- Before preparing a usable fork build, inspect the smallest relevant package build/type/test checks and propose only those needed for that approved client/backend setup. Do not run a broad qualification campaign or treat an extension launch as a substitute for static checks. Build/launch and flag-enabled backend initialization require Gate 1 execution authorization; migration effects require a disposable store and a reviewed recovery path.

### 3. Reviewed controlled nondestructive real-account flows — PENDING

After A and B are reviewed, and after the human explicitly consents to OAuth and bounded provider use, exercise the following once each, in order. Stop on any hard stop. Use A and B only as user-controlled dedicated test accounts for the selected provider. Each row is a separate result; a skipped/inaccessible topology is NOT RUN, not PASS.

The 21 rows below cover all 20 requested flows plus the separate explicit-legacy utility control. CLI, VS Code, and backend-topology rows are coverage checks over the approved sequence, not authorization to repeat destructive mutations for every client.

| # | One-attempt flow | Expected evidence / invariant |
|---|---|---|
| 1 | Add first ChatGPT/OpenAI OAuth account A | A is created and selectable. Explicitly select A as the initial new-session default, create session S_A, and confirm its A binding before changing any default. Identity is represented only by opaque label A. |
| 2 | Add second account B for the same provider | A and B remain distinct profiles and selectable independently. |
| 3 | Assign distinct labels to A and B | Labels remain associated with the intended profiles and disclose no credential material. |
| 4 | Inspect quota/usage independently for A and B | Usage is associated with the selected account; quota does not route or switch requests. |
| 5 | Set B as **Default for new sessions** | New-session default reflects B; no existing session is changed. |
| 6 | Observe an existing A-bound session after the default changes | It remains **Used by this session** A; no reread, retry, or hidden substitution to B. |
| 7 | Create a new session after changing the default | It binds to B as the new-session default. |
| 8 | Reauthenticate one account only | Reauth targets the chosen profile; the other account and its dispatch identity remain unchanged. |
| 9 | Run one standalone utility with explicit account selection | The utility uses the explicitly selected profile and stays on it; no default/account inference. |
| 10 | Run one session-derived utility | It derives authority from the authorized source session and preserves that session's account. |
| 11 | Exercise one subagent path from S_A after the default is B | The child inherits A's profile authority from S_A; no reread of default B or account substitution. |
| 12 | Exercise one fork of S_A after the default is B | Fork retains the parent's explicit binding to A; no implicit account change. |
| 13 | Exercise resume/replay of S_A after the default is B | Resume retains A. Replay displays the recorded binding without leaking credentials or dispatching just to replay; any separately approved continued request retains A. |
| 14 | Exercise CLI flow | CLI behavior and terminology agree with the same explicit/default/session-bound semantics. |
| 15 | Walk the VS Code flow manually | UI presents the same profile/default/session-bound semantics; no credential-bearing screenshots. |
| 16 | Inspect practical local/remote backend scope | Record actual backend/context/process topology. No unsupported workaround; unsupported remote scope is NOT RUN. |
| 17 | Check explicit legacy selection on standalone utility | Only explicit legacy selection is allowed where supported; never implicit legacy fallback. If unavailable, mark NOT RUN with scope. |

Where one flow requires an additional billable provider request, it is still one bounded attempt and must fit the approved budget; otherwise mark NOT RUN. A GUI walkthrough is human-operated and subject to the same single-attempt and consent limits.

**Phase B — UX review during each applicable row:** evaluate add-account flow, picker, labels, default indication, per-session binding, independent quota visibility, reauth, unavailable-account state, delete confirmation, repair, and utility selection. Record UX findings separately from architecture/correctness findings, with safe reproduction steps and severity. Ambiguous terminology is a UX defect; wrong dispatch identity is a potential M10 regression.

**Phase C — operational evidence checklist:** explicitly record whether each invariant was observed, failed, or not exercised. A never silently becomes B; defaults are not reread for bound sessions; retry retains the same profile; refresh remains account-scoped; deletion prevents new dispatch; already handed-off work follows the accepted coordination contract; profile-bound utilities never use legacy credentials; standalone legacy use requires explicit legacy selection; credentials are absent from client-visible state, replay, logs, and configuration; quota never routes accounts. Use only approved sanitized account/profile-to-A/B mappings, not provider identity or credentials. Do not induce unbounded failures or retries: observe one natural retry/refresh if available, otherwise retain a NOT_RUN subcase for review. Coordinate any in-flight deletion observation only under the late destructive gate; absence of such observation is not proof of handoff behavior. One recorded manual attempt may include a product-managed retry; the ban on rerunning a failed flow does not prohibit observing that accepted retry contract.

**Gate 2 — non-destructive evidence review:** review safe CLI/VS Code findings, invariant coverage and any NOT_RUNs before allowing deletion. Stop progression if identity, recovery, migration, budget, or an M10 invariant is uncertain.

### 4. Destructive flows — late and separately gated — PENDING

Do not reach this phase unless step 3 has been reviewed, the operator's independent provider-login recovery path is confirmed, and each action below receives a separate just-in-time human authorization. If deletion could strand the backend or destroy the only recovery path, stop rather than proceed.

| # | One-attempt flow | Gate and expected evidence |
|---|---|---|
| 18 | Delete nondefault account A | Explicit confirmation immediately before deletion; B remains independent and usable. S_A stays bound to the deleted profile and fails closed on new dispatch. Before deleting B, separately authorize re-adding A through supported OAuth and verify the replacement profile A2 while B remains usable; do not repair S_A implicitly. |
| 19 | Delete default account B, with verified A2 available | Separate explicit confirmation immediately before deletion; no automatic promotion, fallback, or silent account swap. Record exact resulting default state safely. S_B retains its unavailable binding. |
| 20 | Observe a session still bound to a deleted/unavailable profile | It fails closed and clearly reports unavailable binding; it must not dispatch with another account. |
| 21 | Explicitly repair S_A or S_B to A2 | Separate confirmation of the target profile; repair is visible and deliberate, with evidence that only the requested session binding changed. Remaining unavailable sessions are not silently repaired. |

Deletion is not assumed reversible. Re-adding may create a new profile, not restore the old identity; any repair must explicitly select the new profile. Do not restore through database/auth-store edits or backups. If the independent recovery path is threatened, mark remaining flows NOT RUN and stop.

**Gate 3 — destructive review:** approve each deletion, any optional in-flight observation, re-add, and explicit repair separately immediately before execution. Do not repair a session with an active handed-off request; review the accepted coordination contract first. Deliberately retaining an unavailable binding for observation is not authorization to dispatch with a replacement account.

### 5. Recovery and reconciliation — PENDING

- Confirm the operator's independent account recovery path, backend/workspace disposal plan, and whether any deleted profile must be re-added through the supported user-facing flow. Re-add only with separate human consent; do not assert identity continuity or restore profile IDs.
- Confirm no credential-bearing artifacts were retained or transmitted. If exposure is suspected, stop ordinary reporting and use the approved secure incident process; do not paste secrets into this plan or issue tracker.
- Reconcile each flow to PASS/FAIL/NOT RUN with the evidence template. Do not retry failures. Identify whether the result is a user-visible defect, unsupported scope, environmental limitation, or inconclusive observation without speculating beyond evidence.
- If a hard stop occurred, preserve only safe evidence and halt all later phases pending secure remediation review.
- For a non-security failure, stop new requests and use supported UI/API cancellation or backend shutdown where safe; preserve already-handed-off request handling under the accepted contract. Revert only documented reversible labels/default choices explicitly. Do not unbind/repair other sessions, downgrade migrated stores, or attempt a secret-bearing backup restore. If supported recovery is unclear, leave the disposable backend stopped and request review. Credential exposure uses the approved secure incident channel and human-directed provider revocation, never copied secret payloads.

### 6. Feature-flag recommendation (Phase D) — PENDING

Evaluate `KILO_EXPERIMENTAL_PROVIDER_PROFILES` only as a policy recommendation after dogfood evidence. Keep the flag in place until a separate human policy decision. Do not presume migration is reversible.

The recommendation must explicitly assess:

- enabling behavior and migration effects on existing local stores;
- disabled behavior before and after migration, without claiming safe rollback;
- behavior when disabling after migration, including whether controls remain coherent;
- coherence of UI controls, API and CLI behavior under each state;
- whether every profile control should be hidden when disabled, and whether hidden controls leave account-bound sessions or CLI/API errors intelligible;
- whether destructive disabling would touch real stores (it must not be tested there; any such evaluation is limited to reviewed disposable stores).

State uncertainties and required product/security review. Do not change flag defaults, migration code, controls, API, CLI, or stores under this plan.

**Gate 4 — release posture:** recommend retaining experimental status for the first usable fork build unless dogfood evidence and human policy review support a different decision. The feature's authorization is not flag removal. Obtain an explicit decision on migration/disable support and release posture before proposing M12 acceptance.

### 7. After-dogfood readiness review (Phases B, C, E, F, G) — PENDING

First synthesize safe user-facing and operational findings: account selection, labels, quota visibility, new-session defaults versus existing bindings, repair after account unavailability/deletion, consent, supported backend scope, recovery, and clear failure wording. Recommend concise user documentation that explains concepts and limitations without exposing storage internals; separate deeper developer/operations notes for migration, backend boundaries, evidence limitations, and recovery. Any documentation authoring beyond this plan requires its own authorized scope.

Then conduct a read-only upstream review against the exact dogfood source SHA and diff. Evaluate genericity versus OpenAI-specific leakage, names and terminology, API/CLI/UI consistency, migration and compatibility behavior, errors and secret boundaries, client/backend boundaries, test coverage, documentation, feature-flag policy, commit history, and diff scope. Categorize each finding:

| Category | Readiness meaning |
|---|---|
| Must-fix before upstream PR | Concrete correctness, security, compatibility, privacy, or maintainability blocker; stop and seek separate remediation authorization. |
| Should-fix before upstream PR | Material improvement recommended before PR; disposition must be explicit. |
| Acceptable follow-up | Bounded known limitation with owner/rationale and no misleading claim. |
| Fork-only concern | Deliberate Kilo-specific difference; verify it is not accidentally presented as upstream-generic behavior. |

Review history only from a verified upstream integration baseline. Preserve published history; no rewrite is authorized. A proposed logical commit sequence is advisory only and does not create commits. No PR is created or updated by this plan.

**Phase F — history proposal:** identify and record the actual upstream integration baseline, inspect all canonical commits and the full diff since it, then recommend preservation, reorganization, logical squashing, or partial cleanup with rationale. Propose review-sized groups such as generic profile model/migration, backend binding/security/API, client UX, utilities/subagents/forks, tests, and documentation. Map existing commits to proposed groups and explicitly separate fork-only changes. This is a proposal, not authorization to rewrite published history.

**Phase G — documentation sufficiency:** assess existing user docs for account-profile concepts, new-session defaults, persistent session binding, no-fallback behavior, recovery/repair, quota visibility, utility selection/inheritance, migration, and limitations. Propose concise user-facing updates and deeper architecture/developer notes without unnecessary credential-storage internals. Documentation must be sufficient before acceptance; this planning task does not author those later product docs.

**Gate 5 — readiness disposition:** human review of UX severity/acceptance, operational evidence, migration behavior in real operation, release posture, upstream findings, proposed history structure, and documentation gaps. Any must-fix requires separately scoped corrective authorization and focused revalidation; it is not automatic permission to modify code or reopen historical attribution.

### 8. Acceptance and PR-readiness gates (Phase H) — PENDING

M12 completion, M12 acceptance, and upstream PR readiness are distinct human decisions. Present a concise evidence-based decision packet only after steps 1-7 have been separately authorized and completed. It must include scope and exact source SHA, safe per-flow ledger, failures and NOT_RUNs, hard-stop outcome, recovery status, feature-flag decision, upstream categories, compatibility limitations, and residual risks.

Do not claim M12 acceptance or PR readiness from a passing subset. Require all of the following before recommending acceptance:

- all applicable flows 1-21 have an explicit one-attempt status and safe evidence; any NOT RUN is justified, scoped, and accepted by a human rather than silently counted as passing;
- no unresolved hard stop, credential exposure, account substitution, automatic quota routing, or unreviewed destructive effect;
- account recovery and deletion/repair outcomes are reconciled;
- live dogfood core flows pass; a missing core flow is not waived merely by labeling it NOT_RUN;
- serious UX defects are resolved or explicitly accepted, and migration behavior is understood in real operation;
- M10's accepted invariants remain intact and M11's documented compatibility limitations remain explicit;
- release/feature-flag posture is decided and UX/operations synthesis is reviewed;
- upstream review categories and history/diff review are complete without rewriting history;
- documentation is sufficient, compatibility limitations are explicit, and the proposed PR/commit strategy is documented;
- a human separately records M12 acceptance and, independently, whether an upstream PR may be prepared.

Retain all seven Run 3 historical checkpoint evidence classes as `SOURCE_INSPECTION`; stronger diagnostic observations stay separately scoped and are not promotions of campaign entries. Preserve the six historical GUI NOT_RUN limitations, two executable CLI-skew NOT_RUN limitations, abrupt-migration NOT_RUN limitation, unresolved macOS ARM64 JetBrains prerequisite/build-stage limitation, and macOS Intel not-qualified status. No product or Bun defect is inferred from that platform uncertainty. Do not reopen M11 unless a concrete M12 user failure, release need, or upstream need is identified and a human explicitly decides to reopen it. Further historical attribution remains deferred unless M12 demonstrates it is required for a concrete release/upstream decision. These boundaries remain even if the live walkthrough succeeds.

**Gate 6 — M12 acceptance review:** submit the exit packet, not an automatic acceptance claim. **Gate 7 — separate upstream PR authorization:** no PR creation follows from M12 acceptance without a distinct human decision.

## Current state

Every phase and flow above is **PENDING**. No execution is represented, inferred, or claimed by this document.
