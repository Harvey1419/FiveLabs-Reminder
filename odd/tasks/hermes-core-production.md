# Hermes Core Production Correction

**Objective:** Make the existing Hermes business core reliably preserve and execute user intent across fresh actions, resumed work, persistence, and confirmation—without adding capabilities or changing the model/provider. This is the corrective implementation authorized by the user; it is not a production-readiness claim.

## Problem and why

The accepted corrective plan addresses loss of intent and continuity at execution/persistence boundaries: fresh and resumed actions can translate the same intent differently, valid existing fields can be dropped, displayed references can shift, and temporal or provenance context can be misapplied. The goal is to make existing advertised contracts truthful and consistent end to end.

## Scope and authorization

- **Authorized:** Local source and test changes for existing core behavior on feature branch `fix/hermes-core-production`, with one Conventional Commit work unit per completed task. Keep tests with the behavior they prove.
- **Not authorized:** New features or proactive behaviors, model/provider changes, RLS changes, production mutations, deployment, live-AI calls, push, or PR creation. No database migration or new persisted kind is planned.
- Reuse existing contracts, adapters, persistence and lifecycle facilities; fix or honestly reject unsupported existing advertised parameters rather than expanding capability.
- The repository was reported clean on `fix/hermes-core-production`, based at `5a2cf4398ccd41519f214bf07433861f5970b26b`. Initial reviewed boundary is that base commit; RDD was observed off due to clone-local setting (global on). Do not start or toggle review.
- **TDD:** Strict TDD is enabled by supplied project instructions. Every implementation task must show RED → GREEN → REFACTOR evidence; do not infer a red result.
- **Delivery:** `ask-on-risk` with the user-selected `feature-branch-chain` strategy. Accumulate verified work units on integration branch `fix/hermes-core-production`; future review slices target the integration chain, and only final integration would reach `main` after separate authorization. Preliminary whole-feature forecast is about 1,000–1,600 authored changed lines (additions + deletions; generated files excluded). No PR/push is authorized. Forecast is not a cap: no line-golfing or artificial splits. Record actual authored counts and coherent review-slice commit boundaries as work progresses.
- **Route:** All implementation tasks use delegated direct work. The exploration and cross-boundary preparation are non-trivial, and tasks span multiple files; the parent supplied the bounded read-only map. No source implementation is complete.

## Verification contract

- Baseline already observed before implementation: `pnpm run test:unit` — 102 files, 796 tests passed (exit 0, 25.33s).
- Baseline already observed before implementation: `find src -name '*.js' -print0 | xargs -0 -n1 node --check` — exit 0.
- Per-task focused check: `pnpm exec vitest run --config tests/config/vitest.unit.js <task-test-paths>`.
- Full unit suite: `pnpm run test:unit` (script: Vitest with `tests/config/vitest.unit.js`).
- Source syntax: `find src -name '*.js' -print0 | xargs -0 -n1 node --check`.
- Whitespace/diff: `git diff --check`.
- Baseline results are not implementation verification. At each task closure record actual RED/GREEN/REFACTOR command and result, runtime harness/scenario or explicit N/A with reason, rollback boundary, actual authored changed-line count, Conventional Commit identity, and any failed/skipped/pending checks. Do not check a task until observed evidence exists.
- Database integration and live-AI checks require separate authorization and an isolated environment; keep them pending. Do not claim production readiness until applicable evidence has actually been observed.

## Work units

- [x] T01 — Durable pending-storage compatibility
- [ ] T02 — Canonical fresh/resume adapter parity
- [ ] T03 — Lossless advertised-field semantics
- [ ] T04 — Stable displayed references
- [ ] T05 — Correction and temporal continuity
- [ ] T06 — Current-input provenance, locale and time
- [ ] T07 — Truthful business outcomes and lifecycle
- [ ] T08 — Existing memory correctness
- [ ] T09 — Full acceptance and recovery

| ID | Task and acceptance | Route / dependencies | Status and evidence |
|---|---|---|---|
| T01 | **Durable pending-storage compatibility.** Preserve existing `input_draft` / `proposal_approval` behavior while normalizing through the existing supported `generic_operation` contract where required. Do not add a DB migration or new kind. Preserve already-staged payloads and pinned UUIDs; production persistence failure must be observable and must not be represented as successful local-only progress. | Delegated; multi-boundary persistence behavior and tests. First. | Complete; see T01 close record below. |
| T02 | **Canonical fresh/resume adapter parity.** Share dependency-neutral domain-call construction, validation, normalization, parameters and tool selection; inject the executor for resume. Preserve per-action facts immediately, executed-sibling behavior and unknown-write protection. | Delegated; multiple non-trivial integration files. Depends on T01. | Pending. |
| T03 | **Lossless advertised-field semantics.** Preserve false/none/clear/replace semantics; reminder follow-up/update fields; calendar recurrence, duration, advance/end/Meet update behavior; and supported exact-date reads. Align schema, adapter, domain and persistence. Do not add capabilities. Fix or honestly reject unsupported existing advertised parameters. | Delegated; cross-contract changes and tests. Depends on T02. | Pending. |
| T04 | **Stable displayed references.** If task A1 and B2 are displayed, B2 is completed, then A1 is updated, keep the operation bound to A1. Pin identity before mutation; validate owner/state; do not replace the displayed list with the latest mutation result. | Delegated; reference lifecycle spans multiple files. Depends on T02. | Pending. |
| T05 | **Correction and temporal continuity.** Retain complete active pending-draft context; support explicit supersede-and-replacement via the canonical path. Preserve the resolved original date/time-zone anchor, but derive a new “now”/duration anchor from a new message. Cover Ana's fixture: Oct 1, LA; existing Tue Oct 6 17:00 appointment and same-day 07:00/16:00 alerts. No wrong today/tomorrow, duplicate, or replay. Cover interruption/restart. | Delegated; state and temporal behavior span multiple files. Depends on T02. | Pending. |
| T06 | **Current-input provenance, locale and time.** Separate current user utterance from quoted messages/OCR. Preserve explicit language/time-zone choices; keep Spanish/English behavior consistent; use existing typed time handling for DST/dates; avoid silent location/time-zone overrides. No new framework, dependency or feature. | Delegated; provenance and shared time boundaries. Depends on shared-time path in T02/T03. | Pending. |
| T07 | **Truthful business outcomes and lifecycle.** Confirm only from observed facts; report partial failures accurately; never claim false success. Repair existing task/reminder/Google Calendar links and advance-notice removal/recurrence only; add no automatic relations. | Delegated; outcome facts integrate across execution/persistence. Depends on T02/T03. | Pending. |
| T08 | **Existing memory correctness.** Retrieve standing preferences independently of the newest-30 general-memory limit; distinguish retrieval failure from absence; never treat quoted/OCR content as trusted facts. Do not add proactivity. | Delegated; retrieval/provenance behavior and tests. Depends on T06. | Pending. |
| T09 | **Full acceptance and recovery.** Add anonymized Ana and general variants with state assertions, owned targets, durable pending state, restarts, midnight, DST, Spanish/English, partial failures, timeouts, and no false success/duplicate. Run applicable unit, syntax and diff checks; leave separately authorized DB/live-AI checks pending. | Delegated; integration across all prior work units. Depends on T01–T08. | Pending. |

## Task-close record

### T01 — Durable pending-storage compatibility

- **Outcome:** Legacy `input_draft` / `proposal_approval` run kinds normalize to the existing supported `generic_operation` kind; unknown kinds are rejected. Configured storage failures are surfaced rather than silently falling back to memory. Configured empty active-run reads are authoritative; approvals reload persisted prepared rows; staging requires complete, unique, identity/payload-matched returned rows and marks the run failed when staging cannot be established. No DB migration or new persisted kind.
- **RED → GREEN → REFACTOR:** Initial compatibility RED: 5 failed / 1 passed; implementation GREEN: 7 passed. A later independent gap check reproduced 4 failing regressions while 7 tests passed; corrections addressed configured empty active lookup, stale supplied approval actions, and empty/partial/duplicate/mismatched staging responses. No separate refactor-only test invocation was recorded; final focused and full suites were green after correction.
- **Focused test:** Independent verifier's final focused four-file Vitest run: 33/33 passed. The exact invocation was not retained in the handoff; do not infer it. Writer's earlier initial focus was 4 files / 28 passed before the follow-up correction.
- **Full unit suite:** `pnpm run test:unit` — 103 files, 808 tests passed (writer report after correction).
- **Syntax / diff:** Source JavaScript syntax check and `git diff --check` passed (writer report after correction). Parent will run the final pre-commit `git diff --check` on the committed candidate.
- **Runtime harness:** Vitest mocked-storage/offline boundary only; no live Supabase/database, network, or AI calls. Production database integration remains pending separate authorization and an isolated environment.
- **Failure / environment limitation:** Live database and live-AI behavior were not tested; no production-readiness claim.
- **Rollback boundary:** Revert only `src/agent/core/agent-run.js`, `src/infrastructure/database/agent-runs.js`, `tests/unit/agent/core-conversational-intelligence.test.js`, and `tests/unit/infrastructure/agent-runs-storage.test.js` to remove T01 behavior and its regression coverage.
- **Authored changed lines:** T01 behavior/tests: 420 additions + 59 deletions = 479 authored lines; tracker: 82 additions; combined staged snapshot: 502 additions + 59 deletions = 561 lines.
- **Commit identity:** Pending the authorized local Conventional Commit.
- **RDD outcome:** Disabled/unmanaged under the observed clone-local setting; no review started or toggled. Native risk was reported high/unassessable from untracked inventory.
- **Delivery:** User selected `feature-branch-chain`; no PR or push authorized. Record T01's integration-branch commit as a future-slice boundary; any PR slice above 400 lines needs the appropriate split/exception decision before PR creation.

Complete this per task before checking it off:

- **RED → GREEN → REFACTOR:** commands and observed results:
- **Focused test:** command and exact result:
- **Runtime harness/scenario:** command and exact result, or N/A plus reason:
- **Syntax / full-suite / diff checks:** actual results or explicit pending:
- **Failure, skip, or environment limitation:**
- **Rollback boundary:**
- **Authored changed lines (additions + deletions; generated excluded):**
- **Commit identity (Conventional Commit; feature branch only):**
- **RDD outcome:** disabled/unmanaged under the observed clone-local setting; do not start review:
- **Delivery slice / strategy decision:** user-selected feature-branch-chain; slice boundaries pending observed work-unit counts:
