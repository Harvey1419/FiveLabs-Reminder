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
- Running authored count: pending commits.

## Tasks and acceptance

- [x] **T1: Reinforce shared contract guidance and initial validation.**
  - Route: delegated direct; preparation and multiple non-trivial files require one bounded writer.
  - Reuse narrowly shared recap/payment guidance, preserving the union of existing rules.
  - State strict-wire nullable-field obligations without weakening canonical semantic prerequisites.
  - Apply existing no-history reference sanitization at the initial provider-validation boundary, after projection and before canonical validation.
  - Preserve ordinary reply prose when no historical evidence exists; genuine historical selections retain existing handling.
  - Verify schema structure, all variants, malformed references, partial schedules, profile-source enforcement, and no execution of invalid decisions.
  - Verification: focused regression tests, `git diff --check`, Node syntax checks; independent verification if native assessment is high/unavailable.
  - Proof: baseline 73 tests passed; observed RED 11 failed / 43 passed; final focused 63 passed and expanded baseline 78 passed. Independent verifier observed 63 passed, four structurally unchanged schema variants, syntax and whitespace checks. Parent repeated the 63-test command successfully.
  - Native risk assessment: high/unassessable because the existing untracked inventory was undeclared. Applied the independent-verifier path without starting RDD.
  - Commit: pending work-unit close.
- [ ] **T2: Add complete, privacy-safe attempt diagnostics.**
  - Route: delegated direct; preparation and multiple non-trivial files require one bounded writer.
  - Measure UTF-8 bytes of the actual serialized request, messages, and JSON schema; label component counts as non-additive and not token estimates.
  - Preserve native usage counters and completion/reasoning semantics; missing measurements remain unknown.
  - Expose bounded preparation/fetch/parse-validation timing without altering deadline placement.
  - Classify observed HTTP/envelope rate limits with explicit unknown provenance when evidence is insufficient.
  - Allowlist safe provider/status/code/retry-delay metadata; never log raw requests, freeform errors, personal content, credentials, or header dumps.
  - Keep existing attempt counts, route-control decisions, timeouts and fallback order unchanged.
  - Verification: focused provider tests, diagnostics tests, full offline unit suite, syntax checks and `git diff --check`; independent verification if native assessment is high/unavailable.
  - Commit and proof: pending.

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
- T1 implementation and independent verification complete; work-unit commit pending.
- Additional authorized Haiku experiment: ten attempts, observed Vertex nullable-enum and 42-versus-16 union-limit rejections. Generation-only adapters remained in memory; no model switch or repository changes. Known cost $0.00570645, conservative bound $0.07160057. No semantic-quality or latency conclusion for Haiku.
- Next step: close T1 commit, then implement T2 with bounded edit surfaces and deterministic tests.

## References

- https://openrouter.ai/docs/api/reference/limits
- https://openrouter.ai/docs/api/reference/errors-and-debugging
- https://openrouter.ai/docs/guides/guides/usage-accounting
