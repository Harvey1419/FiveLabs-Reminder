# Hermes token optimization

## Outcome and authorization
Reduce duplicated input and repeated validated work while preserving GPT-OSS-120B, provider routing, reasoning configuration, full action capabilities, canonical backend validation, mixed-turn memory, and natural replies. User authorized implementation and one review PR; explicitly approved current GitHub CLI session reads, branch push and one PR to `Harvey1419/FiveLabs-Reminder`, base `main`. No merge or deployment.

Base: `dca8c1da4ba0479ae94e6d1822a8f46556983b48`.
Branch: `perf/hermes-token-optimization`.

## Evidence and boundaries
Expanded exports identify 32 observed turns / 47 foreground attempts and significant input volume; they do not cover all traffic. Failed-output root cause is unproven without sanitized payloads. No observed foreground sample follows the final deployment. Current provider schema is 18,307 characters, not a measured token count. Dispatch cache success TTL is five minutes despite revision hashing; actual same-revision live miss frequency is unknown.

This PR implements safe groundwork and demonstrated redundancy only. No speculative routing repair, extra retry, compact wire, semantic regex, reduced action limit, model/provider changes, production DB operations, cross-process cache infrastructure, or paid evaluation. Follow-up memory/context and rejected-output changes require specific evidence; do not silently expand this PR.

## Acceptance
- Provider telemetry retains generation IDs and usage, including cached/reasoning tokens, using bounded metadata-only logs without raw input/output or PII.
- A validated policy for the same active preference snapshot remains reusable after five minutes; content/tenant/effective snapshot changes invalidate it. Error TTL, concurrency sharing, cache capacity and semantic reduction remain intact.
- Prompt/schema prose deduplication reduces measured serialized input characters without changing schema constraints or canonical validation; retain temporal, multiaction, references, billing, provenance, language and natural-reply semantics.
- Applicable focused offline regressions and one broad unit closure pass succeed. Offline tests do not establish real-model quality or savings.
- One PR contains observed checks, pending live acceptance, review risks and rollback instructions. No automatic merge/deploy.

## Work budget
Six subagent launches/continuations initially, up to two correction attempts per defect; one source writer at a time. TDD off by standing preference; ordinary relevant regressions required. Native RDD off (`clone_local`, freshly checked). No paid provider calls without a separately authorized aggregate scenario/budget. Preserve unrelated untracked `media/` and video task documents.

## Tasks
- [x] T1: Preserve and expose bounded LLM usage/correlation telemetry. Status: done. Checks: provider-latency regressions 17/17 passed, both changed source syntax checks and diff check passed. Router metadata tested through extracted production normalizer, not full integration. Commit: recorded below after work-unit commit.
- [ ] T2: Reuse validated dispatch policies by effective revision rather than elapsed success TTL. Status: in_progress. Checks: memory-driven dispatch policy regressions, including time advancement, changes and error recovery. Commit: pending.
- [ ] T3: Deduplicate demonstrated static prompt/schema prose while preserving semantic rules. Status: pending. Checks: intent-contracts, agent-core-overview, live-contract-regressions, runtime-model-contract, task-context-reference-safety; before/after pure input-size measurement. Commit: pending.
- [ ] T4: Independent risk-directed verification and single PR publication. Status: pending. Checks: native read-only assessment, focused checks where required, one broad unit closure; `git diff --check`, source/profile/constraint readback and PR CI status. Commit: pending.

## Progress
Read-only audit completed; one implementation scout mapped edit surfaces and offline runners (launch 1/6). Main unchanged. Feature branch created; remote default branch verified as `main`. No applicable repository issue/label policy or PR template found; do not invent Gentle-owned labels.

## Verification limits and rollback
Live model quality, cached-token support, deployed savings, and production cache miss frequency remain unverified. Existing live acceptance workflow requires provider credentials and paid calls; do not invoke it without budget approval. PR may be marked draft until these checks are addressed. Revert reviewed behavior commits or the eventual merge commit through ordinary repository policy; no data/schema migration is planned.

## T1 evidence
Writer launch 2/6 completed: 3 files, +181/-6. Generation ID and usage survive router normalization; successful provider calls emit bounded JSON metadata with unknown counters represented as null in telemetry. Requestless background calls remain unassigned. Existing success log format changed; compatibility will be checked during independent verification. Live cache support and savings unverified.

## Next step
Commit T1, record identity, then dispatch one bounded writer for T2.
