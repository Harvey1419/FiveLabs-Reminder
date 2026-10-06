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
Six subagent launches/continuations initially, up to two correction attempts per defect; one source writer at a time. User explicitly renewed budget by two delegations: one additional bounded correction writer and one independent corrected-candidate verification. Stop after this renewed scope if a blocker remains. TDD off by standing preference; ordinary relevant regressions required. Native RDD off (`clone_local`, freshly checked). No paid provider calls without a separately authorized aggregate scenario/budget. Preserve unrelated untracked `media/` and video task documents.

## Tasks
- [x] T1: Preserve and expose bounded LLM usage/correlation telemetry. Status: done (compatibility and UUID-only metadata corrected). Checks: provider-latency regressions 17/17 passed, both changed source syntax checks and diff check passed. Router metadata tested through extracted production normalizer, not full integration. Commit: `a78b69106f0db25b1bcc3b013bc4aa4681cf7343`.
- [x] T2: Reuse validated dispatch policies by effective revision rather than elapsed success TTL. Status: done. Checks: memory-driven dispatch policy 25/25 passed, syntax and diff checks passed. Commit: `c6ab77e9fa16cbfa8f63fd1981ab80b9e3b6a2d9`.
- [x] T3: Deduplicate demonstrated static prompt/schema prose while preserving semantic rules. Status: done (three concise safeguard phrases restored). Checks: five focused files 132/132 passed; both syntax checks and diff check passed; exact schemas/tool definitions unchanged against T2. Commit: `acf1bb7023322ab8a58f2278c492e801574c8d76`.
- [ ] T4: Independent risk-directed verification and single PR publication. Status: partial; independent checks completed, broad suite has five statically proved baseline failures. Draft PR publication next; no merge-ready claim. Checks recorded below. Commit: documentation checkpoint pending.

## Progress
Read-only audit completed; one implementation scout mapped edit surfaces and offline runners (launch 1/6). Main unchanged. Feature branch created; remote default branch verified as `main`. No applicable repository issue/label policy or PR template found; do not invent Gentle-owned labels.

## Verification limits and rollback
Live model quality, cached-token support, deployed savings, and production cache miss frequency remain unverified. Existing live acceptance workflow requires provider credentials and paid calls; do not invoke it without budget approval. PR may be marked draft until these checks are addressed. Revert reviewed behavior commits or the eventual merge commit through ordinary repository policy; no data/schema migration is planned.

## T1 evidence
Writer launch 2/6 completed: 3 files, +181/-6. Generation ID and usage survive router normalization; successful provider calls emit bounded JSON metadata with unknown counters represented as null in telemetry. Requestless background calls remain unassigned. Existing success log format changed; compatibility will be checked during independent verification. Live cache support and savings unverified. Native assessment initially blocked on unrelated untracked files despite committed range; supported inspect with `untrackedScope: exclude` returned ready and excluded them without staging/deleting. RDD remains off; no native review started. The unavailable assessment requires independent verification.

## T2 evidence
Writer launch 3/6 completed: 2 files, +110/-4. Successful policies no longer expire by age; exact tenant and ordered effective evidence determine reuse until capacity eviction or process exit. Ten-second error TTL, bounded capacity, concurrent deduplication and clone isolation remain intact. Tests cover reuse after five minutes; tenant/content/timestamp/order/ID/removal invalidation; caller-filtered expiry; failed compilation recovery. No measured production savings claimed.

## T3 evidence
Writer launch 4/6 completed: only billing prose duplication removed from agent-core, with regressions in two existing test files. Each removed rule maps to retained PAGOS guidance or unchanged responseCapability schema description. EXECUTE_TURN_DESCRIPTION, canonical/provider schemas and native tool definitions remain exactly equal to T2, including attachment-only variants. Measured serialized prompt+schema: Free 25,544 to 24,769 chars; Pro 25,645 to 24,870; supervised Free 26,333 to 25,558. Each saves 775 serialized characters/bytes (~3%), not a measured token reduction. Raw prompt saves 773 characters. No real-model quality equivalence claimed.

## Review workload
The combined PR is approximately 530 authored diff lines, mostly regression tests and this evidence document. User requested one PR; destination has no discovered size/exception policy. Keep reviewable work-unit commits and do not drop tests or minify to meet an advisory size budget.

## T4 review blocker
Independent verifier launch 5/6 found an introduced legacy-success consumer break: `tests/acceptance/foreground-live.integration.test.js:192-196` counts `attempt purpose=initial` and `outcome=success`; T1 replaced that line. Correct the emitter, preserve the consumer and assertions, and retain one bounded success line. Correction writer is launch 6/6; no more launches/continuations after this budget without user renewal. Broad closure had already run on acf1bb7 before the hold arrived: 141 files passed / 4 failed, 1,533 tests passed / 8 failed, 78.22 seconds. Verifier statically proved five size-budget assertions also fail on base; three wording assertions were introduced by T3. Success-log compatibility writer completed 18/18 focused tests, not yet committed. A further T1 privacy issue needs correction: arbitrary header-derived correlation IDs must not enter new metadata; accept UUID correlation only. Sanitized environment (`DOTENV_CONFIG_PATH=/dev/null`, no real credentials) and existing test-owned temp fixtures/Vitest cache are authorized for offline closure; no infrastructure changes.

## Correction evidence
Compatibility writer 6/6 passed 18 provider tests; renewed correction writer 7/8 passed 73 focused tests and the filtered runtime safeguard (1 passed / 3 unrelated budget tests skipped), plus both syntax checks and diff check. UUID-or-null applies to correlation metadata and legacy prefixes; one success line preserves the unchanged acceptance predicate. Three concise prompt safeguard phrases restored. Corrected serialized savings are 681 chars/bytes (raw prompt 679), not the earlier 775. Representative measurements: Free 25,544→24,863; Pro 25,645→24,964; supervised Free 25,684→25,003 (synthetic supervision differs from earlier fixture). Canonical/provider schema and contract guidance unchanged. No live quality/token savings claim. Correction commit: `560541826c5d31e46f3ccecf810f580f4c5e0efc`.

## Final independent verification
Renewed verifier 8/8 inspected frozen source commit `560541826c5d31e46f3ccecf810f580f4c5e0efc`. Focused provider, overview, onboarding, contracts and dispatch files: 98/98 passed in 1.50s. Broad unit closure: 1,541 passed / 5 failed (1,546 tests), 142 files passed / 3 failed in 78.34s, exit 1. Each ran once with credentials discarded, DOTENV_CONFIG_PATH=/dev/null, dummy Kapso key and ephemeral external-network guard; no external-network denials reported. Existing test-owned temp fixtures and ignored Vitest cache were authorized. Both diff checks and four changed-source syntax checks passed.

All three introduced wording failures are resolved. The unchanged live acceptance predicate counts one synthetic initial success and excludes requestless memory; no paid acceptance executed. New success metadata accepts UUID correlation or null. This is scoped success-log privacy evidence, not certification of unchanged failure/router logging.

Canonical validation/schema, operations, native tools, all admin/attachment provider schemas and EXECUTE_TURN_DESCRIPTION are equal to base; model/provider profiles, reasoning and call-chain paths are unchanged. Before/after source/test aggregate for 282 tracked files was identical: `13c7604413a383146fdd6ddc2f4e24b48ce77dd88152f63aa65ba8dd5a158f45`. Task bookkeeping and unrelated media excluded. No introduced blocker observed; offline proof is not real-model quality proof.

### Five baseline failures (not weakened)
These test files are byte-identical to base. Pure representative-input evaluation proves the same budget assertions fail at base; no base suite was executed.
- audio-and-task-notes.test.js:21: prompt <6000, base 6,799 / current 6,120.
- epistemic-state-authority.test.js:31: description <2600, base/current 3,003.
- epistemic-state-authority.test.js:67: prompt <6000, base 7,393 / current 6,714.
- runtime-context-budget.test.js:30: prompt <6000, base 7,393 / current 6,714.
- runtime-context-budget.test.js:73: description <2600, base/current 3,003.

### Follow-up scope and paid budget
User offered a ceiling of 1,000 OpenRouter requests after implementation for actual-model validation, using existing .env credentials without exposing them. No paid request has run. This is a ceiling, not authorization for arbitrary rounds or production DB/WhatsApp/payment effects. Define isolated synthetic baseline/candidate scenarios, count every retry/fallback within aggregate ceiling, and agree the next bounded execution phase before launching more agents. Implementation/delegation budget 8/8 exhausted. No automatic correction of baseline failures or semantic retry/memory rewrite.

## Next step
Publish one draft PR with observed checks, baseline failures, missing live quality/savings evidence and rollback instructions. No merge or deployment. Baseline gate and live validation remain pending rather than marking this partial task done. No source edits while verification runs. Current T3 native assessment remains unassessable: unrelated untracked declaration is not adopted by committed-only ASSESS even after supported inspect exclusion. Do not retry the unchanged incident or alter unrelated files; returned plan requires independent verification, treating risk as high.
