# Hermes token optimization

## Outcome and authority
Reduce repeated chat generations and total input/output tokens without changing GPT-OSS-120B, provider routing, reasoning, full action capacity, natural replies, independent memory admission or backend authorization.

- Branch: `perf/hermes-token-optimization`.
- Single PR: https://github.com/Harvey1419/FiveLabs-Reminder/pull/111 (draft).
- Base: `dca8c1da4ba0479ae94e6d1822a8f46556983b48`.
- Previous verified/published candidate: `3d4f93c1f0b959fa2c417d8d4a8c5291bb97e75e`.
- Current source checkpoint: `250ff21b68a42248d6060d05b24537a0a8bb5abf` (full offline checks pass; live acceptance remains blocked).
- User explicitly authorizes implementation, work-unit commits, push and updating the SAME PR; no merge or deployment. User requests unattended completion, not per-step permission loops.
- TDD off; fresh clone-local RDD off. Ordinary functional checks remain required.
- Preserve unrelated media, evidence and video task files. Never publish credentials, raw traces, phase handles or synthetic owner IDs.

## Completed increments
| Work | Evidence |
| --- | --- |
| T1 Usage and UUID-or-null correlation telemetry | `a78b691`, compatibility/privacy `5605418` |
| T2 Revision-keyed tenant dispatch-policy reuse | `c6ab77e` |
| T3 Static billing prompt deduplication | `acf1bb7`, `5605418` |
| T7 Exact tenant-scoped query-vector reuse, not result reuse | `311e641`; independent offline/live proof |
| T9 One owned validation identity across batches; durable request reservations | `ac0bf6d`; FK/header correction `60a6eaf`; independent 114 tests |
| T10 Captured causal observer producer/validator mismatch | Private baseline trace; checkpoint `28716f6` |
| T11 Scoped observer producer constraint and restored unchanged size/compatibility gates | `0835a8a`, final `3d4f93c` |

At `3d4f93c`: 132 focused and 1,613 full unit tests passed, all 125 source/script syntax checks passed, six external-network negatives passed. Core CI and GitGuardian were green at the last target-bound read. This is NOT proof that the original chat-generation goal was met.

Previous prompt measurement: Free serialized input 25,544/25,587 characters/bytes to 24,146/24,192; admin 25,645/25,689 to 24,247/24,294. This saves 1,398 characters / 1,395 bytes, not measured tokens. Context 5,998 characters (<6,000), description 2,287 (<2,600); thresholds were not raised. Query reuse reduced embeddings but chat generations remained roughly 3–4 per message.

## Current tasks
- [ ] **T13 — Implement central-call reduction.** In progress. The first writer stopped before edits or paid calls because the parent incorrectly assigned credential access and private live-run outputs/deletion to a code-only role. Corrected routing: writer only implements code/tests and performs non-mutating syntax/diff checks; verifier runs actual functional/live commands. Code now implemented in 13 source/test files (+370/-32 including the new 156-line test). Syntax/diff checks passed; functional/live checks remain pending. Owning foreground schema and intent executor were explicitly added to the scoped surfaces by the parent; no runtime credential/output access granted to the writer.
- [ ] **T14 — Verify the original goal using the existing runner.** Verification finished; acceptance PARTIAL/BLOCKED (persistent English locale failed and total-token usage incomplete). User explicitly selects unchanged `closure-cases` (10 turns), one fresh phase with hard cap **80**, three-second pacing and final cleanup. Compare with the recorded pre-change 3d4 run; disclose that this is a historical fixed-scenario comparison, NOT a new simultaneous controlled A/B or same-identity before/after. Do not repeat another baseline or invent a 12-turn corpus.
- [ ] **T15 — Publish verified result in the same PR.** Checkpoint publication in progress; keep DRAFT, not ready. Source checkpoint commit identity will be recorded below. Commit source/tests/docs together, push same branch, replace stale PR description, observe CI at the exact delivered HEAD. Mark ready only when agreed performance/functional gates have observed evidence; no merge/deploy.

### T13 design
The primary validated decision also proposes grounded learning candidates from CURRENT trusted user input. Preserve legacy callers with absent metadata. With supplied validated metadata, reuse existing literal grounding, current-text eligibility, independent semantic admission and owner-bound persistence, without another extraction generation. Empty proposals require no extraction/admission; new grounded proposals still require independent admission. Explicit memory saves and queued/CLI learning must not duplicate or drop mixed facts. Metadata does not authorize effects; actual authenticated owner remains authoritative.

Use existing typed `returnFields` for simple task status/date/note questions; retain additional model interpretation for genuinely complex derivations. Deduplicate redundant provider descriptions without deleting unique semantic rules or changing existing fields/enums/bounds/actions/ref/time authority. Additive learning metadata is permitted; no validators weakened, new regex routing, extra classifiers/retries, smaller models, DB migration or new runner.

### Acceptance and stop conditions
- Target at least **30% fewer chat generations** and **20% fewer total generation tokens** for the fixed messages. Ordinary turns aim for 1–2 generations; required complex steps still count.
- Preserve personal facts, contact-preference supersession, locale, task creation/note removal/status, mixed recall, quoted/untrusted exclusion, ownership and strict backend checks.
- Report usage coverage. Reasoning is a completion subset and cache is an input subset: never add either again. Unknown usage/invoice cost remains unknown; historical comparison cannot prove universal savings or causality.
- One coherent implementation and one independent functional/live closure; at most two corrections for observed introduced defects, at most six delegations overall. Three writer dispatches consumed (first safety stop, bounded mapping continuation, implementation). Zero new paid requests so far. Independent verifier slot4 passed all 136 focused tests but broad closure had 28 introduced compatibility failures: 26 outdated producer fixtures supplied null for the new required array, and two exact recap anchors were removed. Live stopped before any paid call. Correction slot5 fixed producer fixtures, restored recap anchors and added actual-current input savings checks; 112/112 relevant tests and syntax/diff passed. Actual Free/admin input is 24,835/24,936 characters and 24,881/24,983 bytes (709 characters/706 bytes saved), native schemas 18,996/19,012 characters, contexts 5,742/5,826 and description 2,287. Old reconstructed snapshots remain explicitly compatibility controls, not current savings proof. Final verifier slot6 performs one post-correction broad closure then user-selected live workflow; no further automatic source/model round beyond this budget. No diagnostic/summary scope expansion or new infrastructure.
- The known summary/reference failure is a follow-up, not the optimization gate unless newly introduced, a reproducible agreed-scenario regression, data integrity or security.
- Never claim completion while required proof fails or is unavailable. Safety/budget stops produce honest draft status and cleanup, not additional paid rounds.

## Live execution selected by the user
Existing authorized key stays private in process environment. The verifier may use secure SDK/dotenv bootstrap, never print keys or give them to the code-only writer. Expected generated outputs are the runner's private `hermes-chat-phase-*` directory (receipt/journal/lock/batch reports) and private `hermes-provider-trace-*` directory; these are verification outputs, not source edit surfaces.

```sh
HERMES_CHAT_OPENROUTER_REQUEST_LIMIT=80 node scripts/dev/run-chat-validation.js --phase create
HERMES_CHAT_SCENARIO=closure-cases HERMES_CHAT_PROVIDER_TRACE=1 node scripts/dev/run-chat-validation.js --phase run <handle>
node scripts/dev/run-chat-validation.js --phase finalize <handle>
```

Create once, retain the same identity if a bounded correction is needed, restart CLI on changed code, finalize once after owned processes stop. All attempts/embeddings/fallbacks/timeouts count against the phase cap. Complete finalization must establish all 14 zero-residue readbacks. No customer records, scheduler, WhatsApp delivery, payment or integration effects. Old phase handles are closed and must never be resumed. The temporary `core-cost-cases` fixture was removed; scenario source is unchanged.

## Final current-increment verification
Independent final closure: **1,639/1,639 tests, 148 files**, six external-network negatives, all changed JS syntax and diff checks passed. Model/provider/reasoning/temperature/max-tokens/streaming configuration and all pre-existing schema constraints were preserved in actual captured requests (ignoring only additive learning metadata/descriptions).

Existing user-selected create → closure-cases → finalize executed once: **10/10 turns**, 3,001–3,003 ms pauses. The trace lacks five upstream events, but has zero unfinished calls and no IO errors; exit 1 reflects trace incompleteness, not an unexecuted conversation. API spend **36/80**, finalization once, journal finalized, lease null/no lock, writer/child/group inactive, **all 14 owner-bound residue readbacks zero**. No customer or payment/WhatsApp/integration effects.

| Fixed historical scenario metric | Before 3d4 | After current code |
| --- | ---: | ---: |
| Chat generations | 33 | 21 |
| Embeddings | 16 | 15 |
| All requests | 49 | 36 |
| Separate extraction calls | 9 | 0 |
| Independent admission calls | 4 | 3 |
| Initial calls including fallback | 16 | 16 |
| Policy compilation | 3 | 2 |
| Observer calls | 1 | 0 |
| Known chat usage coverage | 29/33 | 16/21 |
| Known input tokens | 101,881 | 76,317 |
| Known completion tokens | 15,762 | 13,761 |
| Known combined tokens | 117,643 | 90,078 |

Observed chat reduction **36.36%**, known-token reduction **23.43%**. **Total-token reduction is NOT proven**: four before/five after generations lack usage; invoice/embedding cost unknown. Do not advertise reduced admission/policy calls as pure optimization: the missing English preference may account for those differences. First-primary validity **5/10 → 4/10**; after six initial failures recovered through existing fallbacks (including two upstream rejections of `learningCandidates:null`). This is not evidence of improved validity or universally one-call turns (chat per turn 3,2,2,4,2,1,1,2,2,2).

**Acceptance blocker:** Turn 7 explicitly requested English from now on. The accepted decision selected responseLanguage=en, learningCandidates=[], profileUpdate=null. DB locale remained es-CO through turn 10, with no durable English preference; historical before ended en-US. The scenario differs in acceptance, although introduced causality is not definitively proven. Name/city/dog were durably stored; old phone preference inactive/new text preference active; quoted English instruction not persisted; task note cleared to NULL with same ID/title/pending status; mixed dog/task and contact recall worked. Summary returned historical prose; its verification-limit wording is a separate quality follow-up.

Current static representative input saves 709 characters/706 bytes versus the original fixture, but live initial wire across 16 bodies **grew 434,981 → 444,124 bytes**. Bytes are not tokens; no per-call input reduction or universal quality/cost claim.

Six-delegation budget exhausted; **no further automatic source correction, model run or verifier**. Preserve this code/test/evidence checkpoint in the SAME draft PR, report both remaining gates, no ready/merge/deploy. Source checkpoint: `250ff21b68a42248d6060d05b24537a0a8bb5abf`, `perf(agent): reuse validated primary learning proposals`. It contains source, tests and this feature evidence; publication is a draft checkpoint, not an accepted/merge-ready outcome.

## Recorded baseline and remaining limits
Actual aggregate used: **241/1,000 requests** (205 prior + 36 current). New phase is CLOSED, its unused 44 requests do not authorize another cycle; all old handles remain closed.

Most recent 3d4 baseline: unchanged 10-turn closure scenario, **49 requests = 33 chat + 16 embeddings**. Available chat usage 29/33: 101,881 input + 15,762 completion; 11,581 reasoning already included in completion, 3,584 cached input already included in input. Embedding usage/invoice cost unavailable. Trace had four missing upstream envelopes, zero unfinished events/IO errors. Full phase finalized with all 14 readbacks zero, no owned processes.

Task pending/notes, dog recall and changed contact preference worked; final summary failed after required `excluded` missing, invalid personal refs mixed with operational UUID-shaped refs, then unusable JSON. Introduced causality was not proven. No irrelevant-recall fix or broad production/WhatsApp/Free-Pro/temporal quality certification claimed. Optional temporal/multiaction live cases remain skipped. Native inspect/assessment for the new candidate was attempted once: inspect declared RDD disabled and did not adopt the supplied intended new test, assess remained unassessable due untracked declaration. No retry, authority mutation or unrelated staging/deletion. Native plan treats candidate as high risk and requires independent verification; no native approval claimed. Independent conservative verification is required.

PR body is stale (initial increment and 60-request evidence); final publication must replace it truthfully. Detailed historical task journal is preserved in Engram task mirror history (3818, revisions before this reconciliation); this file now records current decisions and verified checkpoints rather than repeating old inventories.

## Rollback
No migration. Keep all increments in the same PR as explicitly requested. After merge, a reviewed revert of the squash/merge commit can roll back the PR; no automatic destructive Git operation, rollback, merge or deployment.
