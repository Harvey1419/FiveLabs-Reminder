# Groq contract reinforcement and attempt observability

## Objective

Preserve Hermes capabilities and Groq-first routing while strengthening the initial structured-decision boundary and adding truthful, privacy-safe request, latency, and rate-limit diagnostics.

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
- Forecast: 400-500 authored changed lines including tests; this is not a code-size constraint.
- Work-unit boundaries: T1 contract; T2 observability. Do not publish automatically.
- Running authored count after T1: 332 lines (325 insertions + 7 deletions), including the feature document. User-approved size exception remains in effect.

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
  - Commit and proof: pending.
  - Progress: request diagnostics implemented; baseline 37 passed, observed RED regressions, focused closure 110 passed after the user authorized the transport expectation adapter. Full feature closure remains blocked by T1 phrase failures.
  - Closure: conflicting outer/nested/provider codes now keep rate-limit provenance uncertain. Observed RED 4 failed / 28 passed, then 121 provider-focused tests passed. Full offline suite: 1,761 tests passed in 153 files. Independent verifier first checked 190 tests and identified the conflict bug; follow-up checked 32 tests and 22 provenance cases with no remaining blocker. Parent repeated the 121-test command and whitespace check successfully.
  - Native risk assessment remained high/unassessable because pre-existing untracked paths were undeclared; completed the independent-verifier path without starting RDD. RDD outcome: disabled/unmanaged.
  - Unit commit: pending final local close.

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
- Next step: close the diagnostics commit and hand off the local branch. A future production comparison or provider/retry strategy requires separate authorization; no deployment or additional paid calls.

## References

- https://openrouter.ai/docs/api/reference/limits
- https://openrouter.ai/docs/api/reference/errors-and-debugging
- https://openrouter.ai/docs/guides/guides/usage-accounting
