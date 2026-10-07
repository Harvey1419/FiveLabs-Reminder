# Hermes token optimization

## Outcome and authorization
Reduce duplicated input and repeated work while preserving GPT-OSS-120B, provider/reasoning configuration, full action capabilities, canonical backend authority, mixed-turn memory and natural replies. User authorized implementation, feature commits, branch push and one review PR to `Harvey1419/FiveLabs-Reminder`, base `main`. No merge or deployment.

- Base: `dca8c1da4ba0479ae94e6d1822a8f46556983b48`.
- Branch: `perf/hermes-token-optimization`.
- Single draft PR: https://github.com/Harvey1419/FiveLabs-Reminder/pull/111 .
- Verified behavior commit: `560541826c5d31e46f3ccecf810f580f4c5e0efc`.
- Live-tested head: `60df34c04b696220dbe9960cfcb11e937ab1d464` (subsequent implementation commits were documentation only).

## Scope and non-goals
This is the first bounded optimization increment: usage telemetry, revision-keyed policy reuse and demonstrated prompt deduplication. No weaker validators, semantic regex routing, reduced action limit, compact wire, new retries, model/provider changes, memory-admission fusion, schema migration or new production service. Broader memory/context and invalid-generation changes remain follow-ups requiring causal evidence. Preserve unrelated local video/media work.

## Tasks
- [x] T1: Preserve bounded usage/correlation telemetry. Unknown counters remain unknown; reasoning is a completion subset. Compatible single success line with UUID-or-null correlation. Commits `a78b69106f0db25b1bcc3b013bc4aa4681cf7343`, correction `560541826c5d31e46f3ccecf810f580f4c5e0efc`.
- [x] T2: Reuse validated dispatch policies by exact tenant/effective ordered preference revision, not five-minute success expiry. Preserve ten-second error TTL, capacity, concurrent sharing and clone isolation. Commit `c6ab77e9fa16cbfa8f63fd1981ab80b9e3b6a2d9`.
- [x] T3: Deduplicate billing prompt guidance while retaining explicit safeguards and identical schemas. Commits `acf1bb7023322ab8a58f2278c492e801574c8d76`, correction `560541826c5d31e46f3ccecf810f580f4c5e0efc`.
- [ ] T4: Final review/merge gates. Status partial: PR published, independent verification recorded, Core CI FAILED; five baseline budget assertions unresolved. Documentation checkpoint `9605cf4c032b13d13262ff37c76bb9c9525246f4` / publication `60df34c04b696220dbe9960cfcb11e937ab1d464`.
- [ ] T5: Actual-model quality/cost verification. Status partial: first real paced CLI conversation and cleanup verified; five invalid-generation attempts and one relevance issue observed. No baseline A/B run or general quality/savings certification.

## Budgets and preferences
TDD off and clone-local RDD off. Initial six implementation delegations were explicitly renewed by two for corrections/final verification; all eight used. Subsequent live phases and continuations were individually authorized; no remaining allowance automatically authorizes another round or fix.

User granted a ceiling of 1,000 OpenRouter requests after implementation, using the existing key without exposure. User later explicitly authorized fresh synthetic Supabase identities, owned writes and deletion of only their associated records. Latest renewed scope: one canary creation/deletion proof, then at most one ten-turn CLI conversation, three-second interturn pauses, cap 120 provider requests including embeddings and every fallback. **Actual aggregate usage: 60/1,000; remaining ceiling 940. Stop automatic paid work after this run.**

## Independent offline verification
Final source candidate `5605418`:
- 98/98 focused regressions passed in five files.
- Broad closure: **1,541 passed / 5 failed**, 1,546 tests; 142 files passed / 3 failed in 78.34s. Suite is not green.
- Four changed-source syntax checks and both diff checks passed.
- Canonical/provider schemas, operations, tools, EXECUTE_TURN_DESCRIPTION and all admin/attachment variants equal to base. Model/provider profiles, reasoning and call-chain paths unchanged.
- Credentials discarded, dotenv disabled, dummy Kapso key and ephemeral external-network guard; existing test-owned temporary fixtures allowed.
- 282 tracked source/test digest before/after: `13c7604413a383146fdd6ddc2f4e24b48ce77dd88152f63aa65ba8dd5a158f45`. Task bookkeeping and unrelated media excluded.

Three introduced wording failures, legacy success-counter compatibility and correlation-metadata privacy were corrected without weakening existing acceptance assertions. UUID-only evidence applies to the changed success path, not all pre-existing failure/router logs.

### Five established baseline failures
Files are byte-identical to base. Pure representative-input evaluation proves the same limits fail at base; no base suite was executed.

| Assertion under tests/unit/agent | Base | Candidate | Limit |
| --- | ---: | ---: | ---: |
| audio-and-task-notes.test.js:21 prompt | 6,799 | 6,120 | <6,000 |
| epistemic-state-authority.test.js:31 description | 3,003 | 3,003 | <2,600 |
| epistemic-state-authority.test.js:67 prompt | 7,393 | 6,714 | <6,000 |
| runtime-context-budget.test.js:30 prompt | 7,393 | 6,714 | <6,000 |
| runtime-context-budget.test.js:73 description | 3,003 | 3,003 | <2,600 |

Native read-only assessment remained unavailable because unrelated untracked scope was not adopted by committed-only ASSESS after supported inspect exclusion. No staging/deleting unrelated paths or repeated authority operations; conservative independent verification applied. RDD stayed off.

## Measured prompt reduction
Corrected representative serialized prompt + schema decreases by **681 characters/bytes**, raw prompt by 679:
- Free: 25,544 → 24,863.
- Pro: 25,645 → 24,964.
- Representative supervised Free: 25,684 → 25,003.

These are characters, not tokens. The 18,307-character provider schema and its constraints remain unchanged. Actual A/B token/cost savings and production policy miss frequency are not measured.

## Live validation: real CLI and Supabase
Reused `scripts/dev/run-chat-validation.js` → `npm run chat`, unchanged `closure-cases` fixture, fresh `hermes-chat.<UUID>` identities, ephemeral ownership/network guards, scheduler disabled and provider trace off. No actual WhatsApp delivery, payment or integration effects. Source/test/config remained unchanged.

Canary: absence proven, POST 201 created one user, DELETE 200 removed one user filtered by exact ID/phone; 14 final owner-scoped readbacks returned zero. This proved DELETE works despite OPTIONS not advertising it.

One real candidate conversation executed **10/10 turns**, not ten unqualified quality passes:
1. Persisted synthetic name, residence and dog name.
2. Rejected a quoted language instruction; answered in Spanish.
3. Stored telephone contact preference.
4. Updated preference to text messages, previous preference inactive.
5. Created a pending task with exact requested description.
6. Cleared only description to null; same task ID, title and pending status.
7. Answered in English and confirmed pending task.
8. Listed task and recalled dog correctly.
9. Recalled text-message preference correctly **but appended an irrelevant dog-memory quotation**.
10. Summarized observed task/preference state coherently.

The actual fixture did not contain separate name/city queries, a post-deletion standalone note query or a quoted-city case. Earlier pre-run narrative indexing was corrected; no conversation replay.

### Real request accounting
- **60 calls = 34 chat + 26 embeddings**, ledger and exit counter agree.
- Chat: 29 GPT-OSS/Groq, four GPT-OSS/Cerebras, one GLM/Baseten through the unchanged configured fallback chain.
- All HTTP 200; **five structured-output rejection/validation failures** recovered through existing routes. HTTP success is not contract validity.
- 59 responses with usage: 111,171 input tokens; 14,983 completion; 10,876 reasoning included in completion; 7,424 cached included in input.
- Reported usage cost **USD 0.03006367**; one missing usage envelope, invoice total unverified.
- Pauses 3.001–3.010 seconds; message intervals 11.132–18.734 seconds.
- Wait after write 6.036–13.540 seconds, including DB/routing/memory. Auxiliary observer responsePromptAt/responseWallMs captured retained prompt text and must not be used as latency.

### Shutdown and cleanup
npm/chat exit 0, owned process group stopped and no workers remaining. Removed one owned task, six memories, twenty messages and the fresh CLI user. All fourteen final ownership readbacks returned zero; no owned runs/prepared actions remained. Canary and conversation identities both removed. No customer records adopted or deleted.

Local detailed evidence (not automatically published):
- odd/evidence/hermes-token-optimization/live-cli-2.json
- scratch/chat-validation-hermes-token-3364a624-deeb-4aee-bfff-857c5ea98ba5.json

## Earlier preparation failures
Prior isolated batches selected zero runnable tests or failed offline collection gates; no paid calls. Paced isolated phase also stopped before any key/network use. First CLI OPTIONS preflight did not establish cleanup but was not a permission denial. Prior artifacts remain local, accurately marked blocked/partial; none are live passes. This preparation overhead did not alter Hermes or consume provider budget.

## Review and next step
Keep the same PR #111 in draft. Core CI failed and GitGuardian succeeded at last observation. No automatic merge/deploy. Remaining work requires a newly bounded scope: address/disposition baseline CI gates, diagnose invalid-generation attempts from sanitized causal evidence, remove irrelevant recall contamination, and broaden actual-model coverage (Free/Pro, temporal/multiaction, memory/reference cases). Do not claim these findings were introduced by the optimization without baseline comparison, or treat current-only results as A/B savings proof.

## Rollback
No data migration. Before merge, close the draft/branch through ordinary policy. After merge, use a reviewed revert of the squash/merge commit with explicit human approval (`git revert -m 1 <merge-sha>` for a merge commit). Preserve telemetry compatibility/privacy if selectively reverting. No automatic destructive operation.
