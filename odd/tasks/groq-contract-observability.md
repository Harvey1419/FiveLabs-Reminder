# Groq contract reinforcement and attempt observability

## Objective

Preserve Hermes capabilities and Groq-first routing while strengthening structured decisions, measuring attempts, reducing the actual provider-description payload, and building a reproducible synthetic before/after evaluation.

## Problem and rationale

Observed structured-output failures trigger additional provider attempts. The provider validates before the router's existing no-history reference sanitizer, which can reject or strip a valid ordinary reply too early. Existing prompt-size logs do not measure the complete wire request. OpenRouter documents both platform and upstream rate limits; another Groq call cannot guarantee recovery.

## Authorization and constraints

- Local implementation and deterministic offline verification are authorized.
- Keep models, provider order, reasoning, output limits, timeout budgets, history, ownership, approval, and unknown-side-effect safeguards unchanged.
- No automatic rate-limit retry or replacement of Cerebras/GLM fallbacks.
- No paid inference, production/database operations, credentials inspection, deployment, push, PR creation, or merge.
- Preserve all pre-existing untracked evidence and demo task documents.
- Artifact language: English. No AI attribution in commits.
- RDD is OFF, decided by clone-local preference; do not enable it.
- No authoritative strict-TDD configuration was established. Applicable deterministic regression tests follow observed RED -> GREEN -> refactor as the default test-first policy.

## Delivery

- Branch: `fix/groq-contract-observability`.
- Branch point and initial review boundary: `17fb1fe79ac9da911ea6ab9af400de968342a1d1`.
- Delivery strategy: `exception-ok`, single future PR without a line limit, explicitly requested by the user in the organization question.
- Initial forecast: 400-500 authored changed lines. Authorized continuation forecast: T3 approximately 200-350 and T4 approximately 650-1,000 additional lines including tests/docs. These are advisory estimates, not size constraints.
- Work-unit boundaries: T1 contract; T2 observability; T3 actual provider-description compaction; T4 reproducible evaluation. Do not publish automatically.
- Running authored count for the three work-unit commits: 1,060 lines (939 insertions + 121 deletions), including feature-document updates and the compatibility repair. User-approved size exception remains in effect; no code was omitted to meet a line target.

## Tasks and acceptance

- [x] **T1: Reinforce shared contract guidance and initial validation.**
  - Route: delegated direct; preparation and multiple non-trivial files require one bounded writer.
  - Reuse narrowly shared recap/payment guidance, preserving the union of existing rules.
  - Preserve existing strict-wire nullable-field obligations and schema-enforced completeness without weakening canonical semantic prerequisites. Do not add duplicated prompt guidance: experimental expansion violated the existing budgets and was not demonstrated to improve provider behavior.
  - Apply existing no-history reference sanitization at the initial provider-validation boundary, after projection and before canonical validation.
  - Preserve ordinary reply prose when no historical evidence exists; genuine historical selections retain existing handling.
  - Verify schema structure, all variants, malformed references, partial schedules, profile-source enforcement, and no execution of invalid decisions.
  - Verification: focused regression tests, `git diff --check`, Node syntax checks; independent verification if native assessment is high/unavailable.
  - Proof: baseline 73 tests passed; observed RED 11 failed / 43 passed; final focused 63 passed and expanded baseline 78 passed. Independent verifier observed 63 passed, four structurally unchanged schema variants, syntax and whitespace checks. Parent repeated the 63-test command successfully.
  - Native risk assessment: high/unassessable because the existing untracked inventory was undeclared. Applied the independent-verifier path without starting RDD.
  - Commit: `53ec764` (`fix(agent): reinforce initial structured intent validation`). RDD outcome: disabled; no native review transaction started.
  - Reopened: full-suite verification exposed T1-caused prompt-budget growth and a source-extraction adapter failure. A compact candidate restored budgets but omitted four protected phrases. Resolve this by restoring compatible rendered guidance, retaining the actual first-boundary sanitizer fix, and centralizing authored fragments only where rendered semantics stay unchanged. Deeper prompt compaction is deferred, not claimed as complete.
  - Closure: restored byte-identical original rendered guidance, canonical schema and four provider schema variants; original budgets and golden checks remain unchanged. The real initial-callback fix and actual sanitizer test dependency remain. Focused compatibility checks: 244 passed. Compatibility correction commit: `59caf85`.
- [x] **T2: Add complete, privacy-safe attempt diagnostics.**
  - Route: delegated direct; preparation and multiple non-trivial files require one bounded writer.
  - Measure UTF-8 bytes of the actual serialized request, messages, and JSON schema; label component counts as non-additive and not token estimates.
  - Preserve native usage counters and completion/reasoning semantics; missing measurements remain unknown.
  - Expose bounded preparation/fetch/parse-validation timing without altering deadline placement.
  - Classify observed HTTP/envelope rate limits with explicit unknown provenance when evidence is insufficient.
  - Allowlist safe provider/status/code/retry-delay metadata; never log raw requests, freeform errors, personal content, credentials, or header dumps.
  - Keep existing attempt counts, route-control decisions, timeouts and fallback order unchanged.
  - Verification: focused provider tests, diagnostics tests, full offline unit suite, syntax checks and `git diff --check`; independent verification if native assessment is high/unavailable.
  - Commit and proof: recorded in the closure below.
  - Intermediate proof: baseline 37 passed, observed RED regressions, focused closure 110 passed after the user authorized the transport expectation adapter. The subsequent T1 phrase failures were resolved before final closure.
  - Closure: conflicting outer/nested/provider codes now keep rate-limit provenance uncertain. Observed RED 4 failed / 28 passed, then 121 provider-focused tests passed. Full offline suite: 1,761 tests passed in 153 files. Independent verifier first checked 190 tests and identified the conflict bug; follow-up checked 32 tests and 22 provenance cases with no remaining blocker. Parent repeated the 121-test command and whitespace check successfully.
  - Native risk assessment remained high/unassessable because pre-existing untracked paths were undeclared; completed the independent-verifier path without starting RDD. RDD outcome: disabled/unmanaged.
  - Unit commit: `8a4d337` (`feat(agent): add privacy-safe provider attempt diagnostics`).
- [x] **T3: Reduce actual provider descriptions without weakening contracts.**
  - Route: delegated direct; source preparation and multiple non-trivial files require a bounded writer.
  - Baseline for this continuation: `1290e81`.
  - Compact field-local provider descriptions only; keep canonical descriptions, validators, operations, types, bounds, required fields, nullability and runtime capabilities unchanged.
  - Preserve every replaced obligation in explicit model-visible guidance with a documented rule-to-surface map. Initially leave sensitive learning admission guidance intact.
  - Detach shared temporal nodes before editing; avoid accidental schedule changes through aliases.
  - Keep all four description-stripped provider variants and the full canonical schema unchanged.
  - Measure actual serialized request and schema UTF-8 bytes against the baseline. Exploration found approximately 1.8-2.1 KB of plausible reduction; this is not measured token or latency improvement.
  - Separate structural fingerprints from intentionally changed descriptions; preserve budget guards and semantic assertions rather than regenerate arbitrary goldens.
  - No new provider unions, references, classifiers, model changes, reasoning reduction, history truncation or simultaneous dynamic-context deduplication.
  - Verification: observed regression RED/GREEN, focused contract/budget suites, full offline units, syntax/whitespace checks and independent verification as required.
  - Commit and proof: recorded in the closure below.
  - Closure: baseline 250 tests passed; observed RED 6 failed / 8 passed; focused GREEN 269 passed; full offline suite 1,780 passed in 154 files. Independent verifier and parent each ran 139 focused tests successfully, confirming explicit rule preservation and all four unchanged description-stripped schema variants.
  - Actual wire measurements: normal non-admin request 24,913 -> 23,373 UTF-8 bytes, schema 19,058 -> 17,518; admin request 24,929 -> 23,389. Normal saving: 1,540 bytes (6.18%). Attachment-only request 11,253 -> 10,767, saving 486 bytes. Messages remain 5,511 bytes. Native tokens, live acceptance, quality and latency are not yet measured.
  - Canonical SHA-256 remains `40c6cd8f9ba705137012e006127a34ef8edd0da8f929a57874cd705056a9b905`. Risk assessment: high/unassessable due the untracked inventory; independent verification completed without starting RDD.
  - Unit commit: `21f51ba` (`perf(agent): compact provider descriptions without weakening contracts`). RDD remains disabled.
- [x] **T4: Build a reproducible offline-default Groq comparison harness.**
  - Route: delegated direct; multiple implementation/testing files require a bounded writer.
  - Use the real pure prompt, request and validation boundaries for baseline/current sources; do not import executable production evaluation drivers or database actions.
  - Resume checkpoint: preserve user-owned language commit `106f28f`. Compare schema compaction with an explicitly labeled `mixed_source_schema_only` baseline: current prompt/runtime/validators in both arms, only the baseline provider-schema projection from `1290e81`. Record per-source provenance and do not present this as execution of the entire historical runtime.
  - Default dry-run blocks network and credential access. Paid mode requires explicit execution, generation/cost caps and fresh user authorization.
  - Correct date/time, task-description, reference and durable-preference grading; accept canonical alternatives and preserve safe synthetic decisions for review.
  - Separate matched fixed-context pairs from divergent conversations. Failed parents stop dependent turns; never fabricate successful history.
  - Record actual payload sizes, provider-native usage, typed failures, deadline success, correctness and cost; exclude fast errors from response-latency medians.
  - Retain a tested pure request/validation seam without changing production request fields or routing behavior.
  - Preserve current turn-language guards and clarification sanitizers. Add English-context and callback-first parity coverage within existing authorized test surfaces; execute user language regressions without rewriting their expectations.
  - Future evidence is restricted to `odd/evidence/groq-contract-evaluation/`; pre-existing evidence remains untouched.
  - Verification: offline dry-run, isolation/semantic-grader tests, production-wire parity tests, full offline units and independent verification as required.
  - Commit and proof: pending.
  - Closure: resumed baseline 218 tests passed; observed resume RED 4 failed / 44 passed. An independent verifier found reminder-subject/minute grading gaps; observed correction RED 13 failed / 75 passed, then 88 evaluation tests and 269 focused tests passed. Final full offline suite: 1,872 tests passed in 155 files. Independent follow-up repeated 88 tests and canonical-valid negative controls; parent repeated the 88-test command successfully.
  - Dry-run proof: fourteen matched fixed-context pairs, 28 passing synthetic decisions, zero attempts/credential lookups/network requests. Fifty-pair simulation yields 100 synthetic decisions and a conservative reservation forecast of $1.159516217 under documented price assumptions; 61,600 serialized bytes saved across initial-schema cases. Native token savings, model quality and latency remain unknown.
  - English fixture: 26,188 -> 24,648 UTF-8 request bytes, identical 6,786-byte messages. The comparison is schema-only with current language behavior preserved; continuation/approval schemas are identical and have no compaction saving.
  - Reminder grading uses owned subject expectations, declared fixture-only alternatives and resolved date/hour/minute/mode. Unsupported paraphrases are unresolved, not counted as correct or declared backend bugs. Canonical validity alone does not establish semantic correctness.
  - Safety/compatibility: no user language source/test changes; request-builder and validation parity retained. Default dry-run is offline; paid mode requires explicit execution and caps. Reports retain bounded synthetic decisions and provenance, not private prompts or raw provider errors.
  - Native assessment: high/unassessable from the existing untracked inventory; independent verification completed without starting RDD. Unit commit: pending local close.

## Verification plan

Existing baseline and focused runner:

```sh
npm run test:unit -- tests/unit/agent/groq-strict-schema-regressions.test.js tests/unit/agent/recap-evidence-contract.test.js tests/unit/agent/provider-latency-regressions.test.js tests/unit/agent/structured-provider-errors.test.js
```

Add each task's new tests to its focused command. Full offline closure: `npm run test:unit`. Do not invoke `npm test`, credential-dependent integration tests, or live inference runners. No source-mutating normalizer was identified; perform check-only syntax and whitespace checks after edits.

Focused checks are estimated at 10-60 seconds; the full unit suite at 2-10 minutes, unmeasured. Test runners may create local caches and temporary fixtures.

## Progress and recovery

- Exploration complete; source and official OpenRouter documentation mapped.
- Feature document created before source implementation.
- Engram mirror topic: `odd/groq-contract-observability/tasks`.
- Mirror status: pending; memory writes previously refused with `session_already_ended`. Local progress remains authoritative until reconciliation is possible.
- T1 implementation and compatibility repair complete (`53ec764`, `59caf85`); full feature verification is green.
- Additional authorized Haiku experiment: ten attempts, observed Vertex nullable-enum and 42-versus-16 union-limit rejections. Generation-only adapters remained in memory; no model switch or repository changes. Known cost $0.00570645, conservative bound $0.07160057. No semantic-quality or latency conclusion for Haiku.
- Verification limitations: provider behavior is mocked; no production latency, recovery from live 429 responses, integration database checks, or live-model efficacy is certified. Diagnostics do not prevent rate limits and no automatic 429 retry was added.
- Authorized test-surface additions: `tests/unit/agent/structured-protocol-responses.test.js` and `tests/unit/agent/core-learning-candidates.test.js`, each explicitly approved by the user.
- Work units closed locally: initial contract `53ec764`, compatibility repair `59caf85`, diagnostics `8a4d337`, compaction `21f51ba`. T4 is verified offline and awaiting its local commit.
- The user explicitly authorized T3/T4 in the order optimization -> corrected evaluation -> larger comparison, and asked to prioritize Groq while deferring Haiku.
- Prior live before/after comparison used 14 remaining calls and exhausted its 24-call cap. Requests were byte-identical and no code-caused latency/token improvement was demonstrated. Do not reuse that exhausted allowance.
- The user paused writes to inject language corrections, then authorized resumption after commit `106f28f`. Reconciliation found the current T4 wrappers preserve those corrections; previous test receipts are not accepted as proof of this new snapshot.
- T3 and T4 are independently verified offline against the user language commit. Next: close T4 locally and request fresh authorization for a controlled 50-pair/100-generation Groq comparison. No paid calls have been made in this continuation; no push, PR or deployment is authorized.

## References

- https://openrouter.ai/docs/api/reference/limits
- https://openrouter.ai/docs/api/reference/errors-and-debugging
- https://openrouter.ai/docs/guides/guides/usage-accounting
