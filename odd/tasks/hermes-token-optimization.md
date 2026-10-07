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
- [ ] T6: Diagnose and address irrelevant recall using observed decision/effect provenance. Status partial/pending: diagnostic verifier 2/6 parsed logs and proved runtime does not automatically inherit old knowledgeRefs; current model ref selection versus freeform content replay remains unproven without raw decision. No prompt/schema/relevance fix authorized by this evidence yet.
- [x] T7: Reduce identical embedding-query work without sharing tenant search results or weakening memory admission. Status done at writer verification: 176/176 offline tests passed across 17 files, including 12 new query-scope regressions; five source syntax checks and diff check passed. Independent closure/live measurement pending T8. Work-unit commit `311e6416ed3c35809d0629392ba9bcd81ac1fa32`.
- [ ] T8: Independently verify the second increment and perform only necessary bounded real reproductions. Status partial: independent 176/176 passed, broad 1,553 passed / five known baseline failures; postcheck executed 10 turns, 47 API calls (32 chat / 15 embeddings), cleanup verified. No trace was captured; interpretation fallback and relevance remain pending. Same PR #111.
- [ ] T9: Make the existing validation runner support one proven owned identity across correction batches, durable aggregate accounting and built-in three-second pacing. Status in_progress correction: independent audit found two missing FK owner checks despite98 passing tests; closure writer3/6 fixes only helper/tests. Initial work-unit commit `ac0bf6d91c69514da40abc0dc90abf2d3a59fd5b`.
- [ ] T10: Capture bounded baseline decisions/failures on that owned phase before any semantic prompt fix. Status pending guardian correction: verifier2/6 stopped before credentials/DB/paid calls; no phase/user created. Verifier4/6 will review corrected candidate then capturebaseline ifsafe.
- [ ] T11: Resolve CI size gates and evidence-proven reply/fallback defects without weakening validators or capabilities. Status pending baseline evidence.
- [ ] T12: Independent closure, real regression confirmation, same-PR publication and green CI before ready-for-review. Status pending; no merge/deploy.

## Budgets and preferences
TDD off and clone-local RDD off. Initial six implementation delegations were explicitly renewed by two for corrections/final verification; all eight used. Subsequent live phases and continuations were individually authorized; no remaining allowance automatically authorizes another round or fix.

User granted a ceiling of 1,000 OpenRouter requests after implementation, using the existing key without exposure. User later explicitly authorized fresh synthetic Supabase identities, owned writes and deletion of only their associated records. Latest renewed scope: one canary creation/deletion proof, then at most one ten-turn CLI conversation, three-second interturn pauses, cap 120 provider requests including embeddings and every fallback. **Actual aggregate usage: 60/1,000; remaining ceiling 940.** The first live run is closed. User subsequently said Adelante to the proposed next increment; renewed scope below controls any additional work.

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

## Second increment authorization
User said Adelante to diagnosing invalid generations, duplicate memory/embedding work and irrelevant recall on the same PR, preserving intelligence and full capabilities. New initial work budget: six delegations/continuations, at most two correction attempts per defect; writes sequential. Scout 1/6 performs targeted source/evidence mapping only. If raw failed model output is missing, obtain the smallest bounded synthetic trace before another prompt/schema change; do not invent causality or weaken validation. Native RDD and TDD remain off.

Freeze acceptance after mapping and before checks: explicit personal/mixed recall remains supported; unrelated prior memory must not contaminate a current answer unless the actual current decision authorizes that evidence; identical tenant-scoped query vectors may be reused but searches still execute with owner predicates; changed text/model/dimensions never reuse improperly; no knowledge lost from mixed operational/personal turns and independent admission retained. Five existing CI size assertions are not silently weakened or fixed outside this scope.

Additional live cap: 120 requests total for this increment, including every attempt, embedding and fallback; aggregate already spent 60, so at most 180/1,000 after this scope. Remaining allowance is not authorization for new rounds. Use the proven existing CLI runner, fresh synthetic ownership, three-second pauses, scheduler/side effects disabled and zero-residue cleanup. Trace opt-in, if needed, must be private/synthetic/credential-redacted and bounded. Diagnostic verifier 2/6 is authorized for at most 60 API requests to capture six unchanged closure-cases turns (1,4,5,6,8,9: personal seed, text preference, task creation, note removal, task+dog recall, contact question), three-second pauses and proven owner guards/cleanup. Skip paid reproduction if local evidence suffices. Expected artifacts: odd/evidence/hermes-token-optimization/increment-2-diagnosis.json, fresh scratch/chat-validation-hermes-token-inc2-<UUID>.json, and existing runner opt-in private fresh TMP hermes-provider-trace-*/events.jsonl (0700 directory/0600 file, credential redaction, completeness proof, no public/raw trace upload). Actual current decision/validation fields are required before prompt/schema fixes; no inferred cause from missing evidence. Remaining 60 of this increment is reserved for post-change verification; all API calls counted and no extra rounds. No paid call by the source scout. Stop at exhausted budget or uncertain cleanup; report concrete evidence and proposed next step rather than continue automatically.

## Second increment diagnostic progress
Read-only verifier 2/6 parsed retained artifacts in memory, without new paid calls or source writes. Five observed failures: turn 2 initial/primary structured_generation_rejection (actions minItems zero); turn 6 initial/primary INVALID_EVIDENCE_REFS; turn 7 observed_answer primary UNKNOWN and secondary UNKNOWN; turn 9 initial/primary MISSING_CONTENT. Raw choice content/current knowledgeRefs are absent from inspected logs. Fresh personal-knowledge nonce and ref handling do not inherit previous-turn refs automatically; current wrong-ref selection versus repeated freeform text remains unresolved.

Source mapping proves the two attachment-free query paths pass the same trimmed current input and fixed embedding model/dimensions; twenty query calls plus six distinct save embeddings fit the ledger. Exact request bodies were not retained. Search results must remain separate and user-filtered; only identical query vectors may be shared. Existing turn-lease AsyncLocalStorage is private and exited for background extraction, and CLI lacks that scope; do not reuse lease state or long-lived working memory as a vector cache. Minimal independent scope/queue capture and tests are being mapped.

The diagnostic verifier's read-only role cannot author the conditional trace adapter or reports. No paid trace ran; do not override that role or build a large ad-hoc harness to bypass it. Existing proof is insufficient for a speculative prompt/schema patch; preserve this gap and proceed only with source-grounded work.

### T7 frozen acceptance and surfaces
Production surfaces: src/integrations/ai/embeddings.js; src/infrastructure/database/memories.js; scripts/dev/interactive-chat.js; src/http/webhooks/whatsapp.js; src/jobs/memory-extractor.js. One new focused regression file tests/unit/memory/query-embedding-reuse.test.js plus targeted existing memory/messaging regressions. No router, admission contracts, prompt, lease or model configuration changes.

Independent embedding-only AsyncLocalStorage stores one owner-bound query-vector map. It must never snapshot/bind all AsyncLocalStorage stores or carry execution lease/signal into learning. Wrap the resolved-user webhook processing and existing CLI route+extraction block; capture/re-enter only the embedding scope across the shared memory queue. No global scope registry/cache or retained search results. Query metadata is optional; memory-save embeddings bypass reuse. Key exact effective provider input + owner + model + dimensions; pending requests coalesce, null/rejected vectors evict, consumers receive clones, entries bounded per scope. Different turn/user/input never share incorrectly; existing model and 768-dimensional requests remain unchanged. Every search still executes owner-filtered RPC/sparse/topic/hydration queries. Preserve mixed personal facts and independent admission.

Frozen deterministic checks: concurrent and sequential same-query reuse; new turn/owner/query isolation; exact model/dimension identity without new config overrides; failure recovery; clone/capacity isolation; two owner-filtered searches after one vector; saves still embed; captured queued scope survives withoutTurnLease while lease authority remains absent. Credential-free offline focused runner: npx vitest run --config tests/config/vitest.unit.js tests/unit/memory tests/unit/agent/memory-save-unification.test.js tests/unit/messaging/inbound-turn-worker.test.js tests/unit/agent/mixed-personal-response.test.js tests/unit/agent/response-knowledge-scope.test.js. Independent closure after writer returns. Paid usage still aggregate60/1000 and increment0/120; unused trace allowance does not authorize arbitrary runs. Expected live check after source proof remains capped60 requests and requires an exact safe existing-runner invocation.

## T7 writer evidence
Writer 3/6 completed five linked production edits and one new 211-line regression file, 273 additions / 16 deletions (task bookkeeping excluded). Cache is a 32-entry owner-bound embedding-only AsyncLocalStorage map; pending identical queries coalesce, null/rejections evict, returned vectors clone. Saves/legacy calls bypass. CLI/webhook wrap resolved-owner processing; queue captures/re-enters only embedding state at enqueue and .then, preserving withoutTurnLease. No search-result caching, router/admission/prompt/model/provider/reasoning changes.

Focused sanitized command passed 176 tests in 17 files: local Vitest unit config over tests/unit/memory plus memory-save-unification, inbound-turn-worker, mixed-personal-response and response-knowledge-scope. Source syntax and diff checks passed. New regressions cover sequential/concurrent reuse, user/turn/query isolation, failure eviction, clones/capacity, saves, two owned searches after one vector, queued context with absent lease/signal and unchanged mixed-turn admission. Entry-point structural assertions are not full transport integration proof.

Writer digest used a different 294-path manifest including new untracked test, not a match to the previous manifest; independent verifier must define exact tracked source/test/script/package inventory on the committed candidate. No live requests in this increment yet (aggregate60/1000). No relevance fix or measured token/API savings claimed yet.

Expected independent live validation, only after static/offline gates: reuse the previously proven CLI invocation with fresh identity, three-second pauses, closure-cases ten unchanged turns, cap60 API attempts, scheduler off/ownership guards/cleanup. No new adapter authored by read-only verifier; exact existing command and approved variable substitutions only. Local outputs: fresh scratch/chat-validation-hermes-token-inc2-validation-<UUID>.json and odd/evidence/hermes-token-optimization/increment-2-validation.json. Existing supported trace opt-in is now separately authorized on this SAME post-change run if the prior invocation safely supports the parameter substitution: HERMES_CHAT_PROVIDER_TRACE=1, fresh private 0700 TMP directory / 0600 file, owned/no symlink/bounded/completeness checks. No extra API requests or new adapter; no raw trace/key/reasoning upload. If unsafe/unavailable, leave trace off and report the gap rather than block the otherwise valid count check. Stop after one run, cleanup even on failure; compare observed query embeddings with first26-call sample descriptively, without asserting statistical equivalence or all-output quality. Private/synthetic details remain local; sanitized result in same PR. Source frozen during verification at 311e641. Native ASSESS on the new committed range returned unassessable for unrelated untracked inventory; no retries or staging/deleting unrelated files. Returned plan requires conservative independent verification.

## T8 independent progress
Static review passed all five syntax checks and both diff checks. Defined inventory: 295 tracked src/tests/scripts/package.json paths, sorted path+NUL+bytes+NUL; frozen digest `5f24bb4a6c7a8b1f1b6d49f0717ee436c4bf36ad5801c48ceb3d3a74cc8709ef`. Three files containing the five baseline budget assertions are byte-identical to 0a95fb5. No canonical/router/provider/admission/current-user-input change or introduced static blocker.

Verifier 4/6 did not run functional commands because its transcript lacked the required exact offline guard invocation; parent supplied an ephemeral no-file data-URL guard and sanitized local Vitest command to continuation 5/6. Six external-network negative checks passed. Independent focused 17 files / 176 tests passed in 2.97s; broad 143 files passed / 3 failed, 1,553 tests passed / 5 failed in 79.60s. Failures are exactly the five prior size budgets, not weakened; no introduced blocker observed. No paid calls during offline stage. The same previously successful CLI heredoc, only approved literal candidate/cap/report/trace substitutions, is being reused for one post-change conversation; no newly authored live harness.

## Closure authorization and current truth
User explicitly requested completing all reported gates in one go and leaving the same PR ready to merge, without reduced intelligence/capabilities. New bounded closure: six delegations/continuations, at most two correction attempts per defect, writes sequential. User then clarified one test identity per correction cycle, not create/delete for every batch. No further work had started during that clarification pause; parent acknowledged it rather than claiming background progress.

Post-T7 observed totals: 47 calls (32 chat/15 embeddings) versus prior60 (34/26), 46HTTP200 +1HTTP429, five structured invalid attempts +one rate limit. Actual spending now107/1000; remaining893. Usage45/47:106283input14978completion(11158reasoning subset),7168cached input subset,USD0.02933494reported/two missing usage envelopes. Candidate-only before/after counts descriptive, not universal causal A/B savings. English used but one durable language preference memory was absent compared with prior sample; turn7 honest overtechnical fallback; turn9 pertinent preference quote/noNube in this sample is not a relevance fix. Fresh canary/CLI users fully removed,14zero cleanup readbacks/no workers. T7 source311e641 remains local; PR head still0a95fb5 until publication.

Closure paid cap300 additional requests, including every retry/embedding/timeout, from aggregate107 (at most407/1000 after scope). Begin with no paid requests by writer. Capture before changing semantic generation logic; post-fix exact-case checks and one agreed broader pass. If a safety/cleanup/authority issue or work budget exhaustion remains, stop with exact evidence, never claim merge-ready. No silent validator relaxation, smaller models, reduced reasoning/action limits or raised budget assertions.

### T9 acceptance
Reuse the existing CLI runner, not a new test framework. One fresh synthetic user owned by the closure phase; require safe ownership proof for resume, never just adopt a supplied ID/shared default phone. A private generated phase handle bound to repository and database may carry initial creation proof; verify owner/file permissions/no symlinks, fresh absence and exact ID/phone match. Restart CLI between code revisions so new modules load while the same identity/state remains. All batches keep aggregate request accounting across restarts; lock/concurrency and interrupted accounting must fail closed. Only scoped case-state resets if needed; full owned-row cleanup once on phase finalization/terminal abort, after all owned processes stop, with zero-residue readback. Legacy one-shot behavior stays safe/backward compatible.

Built-in runner pacing3seconds and bounded metadata-only request telemetry/private trace opt-in must remove need for large ephemeral adapters. Use existing provider trace producer and trace modes, never output credentials/raw reasoning. This dev validation support must not change model/provider/reasoning configuration, LLM schemas or production behavior. Tests cover wrong owner/target/repository, unsafe handles, resume after closure, pending process refusal, request caps across batches and final cleanup/receipt errors. Exact command examples returned for the verifier to execute without authoring adapters.

## T9 writer evidence and commands
Five changed dev/test files (new private session helper, existing runner/preload/CLI and new lifecycle tests); 718 additions / 16 deletions including 30 new regressions. This exceeds advisory review size; keep a separate work-unit commit within the user-requested single PR. No production/provider/prompt/schema changes. Unit suite 98/98 across four files, four dev-script syntax checks and diff check passed. No phase/user/API calls created by writer.

The helper generates private canonical TMP hermes-chat-phase-<UUID>-<generated>/phase.json plus events.jsonl, bound to repo/database/phone/user ID; locking, parent-child proof and fsynced reservations before each chat/embedding HTTP. Closed/wrong-owner/target/unsafe handles fail closed. Failed batches retain state and require explicit finalization; active/reused PIDs or malformed journals refuse unsafe recovery/cleanup. No case-reset API. Native ASSESS for this new committed range remains unassessable due unrelated untracked inventory; no retry or unrelated staging/deletion, conservative independent safety required before live writes. CLI phase mode runs the same interactive entrypoint in a new Node process (rather than an npm intermediary), allowing direct parent proof and code reload. One-shot default preserved.

Exact supported commands, after staging required SDK keys securely in environment (never argv):
- Create ONCE: DOTENV_CONFIG_PATH=/dev/null KAPSO_API_KEY=dummy HERMES_CHAT_OPENROUTER_REQUEST_LIMIT=300 node scripts/dev/run-chat-validation.js --phase create
- Baseline/resume: DOTENV_CONFIG_PATH=/dev/null KAPSO_API_KEY=dummy HERMES_CHAT_SCENARIO=closure-cases HERMES_CHAT_PROVIDER_TRACE=1 node scripts/dev/run-chat-validation.js --phase run <returned-handle>
- Finalize ONCE at closure/terminal abandonment: DOTENV_CONFIG_PATH=/dev/null KAPSO_API_KEY=dummy node scripts/dev/run-chat-validation.js --phase finalize <returned-handle>

Phase handle and private reports must remain local. Reports are sibling batch-<UUID>.json files; trace paths/completeness recorded there. Cap300 is phase-wide; parent must stop unnecessary extra batches and reconcile spend into total107/1000 prior. Independent verifier must review phase ownership/FK predicates, journal locks and process shutdown BEFORE writes. On terminal safety issue finalize only after owned processes stop, never leave unexplained data. On normal baseline success preserve phase identity/state for T11/T12; parent receives private handle for continuity, not raw keys.

## T9 independent safety blocker
Closure verifier2/6 independently passed98tests/foursyntax/range+workingdiff. It proved a guardian bypass by source: memories.superseded_by→memories(id) and reminders.parent_reminder_id→reminders(id) payload references lacked target-owner lookup while other FKs were checked. Schema evidence schema.sql123/60; supersession is used by memories.js164/212. No actual cross-owner write occurred. No phase/key staging/SDK operations/models were launched; aggregate remains107/1000, closure0/300.

Correct only scripts/dev/chat-validation-session.js and its existing new test file, adding owned/foreign/null cases and pre-I/O denial; no app/prompt/schema changes. Work budget writer3/6 then verifier4/6, leaving product writer5/6 and finalverifier6/6 ifbaseline givescausalevidence. Static manifest297paths sha ecf3d512da8300780649c78aaac67bade5f6e149bc36b321383ccc5d1e09ff59 unchanged at initialac0. No user data or processes to clean.

## T9 guardian correction evidence
Closure writer3/6 added superseded_by→memories and parent_reminder_id→reminders using the existing non-null FK loop; two-file diff35+/1-. Sixteen POST/PATCH owned/foreign/null/malformed cases passed; focused114/114 across four files, syntax and diff passed, no live activity. Parent added a small HTTP content-negotiation compatibility correction: cloned verification GET headers request application/json rather than inheriting SDK application/vnd.pgrst.object+json; original mutation headers/body stay unchanged. Existing FK cases now assert both header behaviors. This final mechanical adjustment awaits verifier4/6 execution before any real DB activity; do not claim114 on the altered candidate until independently rerun.

Correction checkpoint committed next, then verifier4/6 reviews and runs exact installed phase baseline. No new production/prompt/validator changes; no safety shortcut or raised tests. Aggregate107/1000 unchanged, closure0/300, no phase owner exists yet.

## Rollback
No data migration. Before merge, close the draft/branch through ordinary policy. After merge, use a reviewed revert of the squash/merge commit with explicit human approval (`git revert -m 1 <merge-sha>` for a merge commit). Preserve telemetry compatibility/privacy if selectively reverting. No automatic destructive operation.
