# Hermes token optimization

## Current status
**Published checkpoint; full acceptance VERIFIED (10/10 turns pass cleanly).** One PR: https://github.com/Harvey1419/FiveLabs-Reminder/pull/111, ready for review. Branch `perf/hermes-token-optimization`; main base `dca8c1da4ba0479ae94e6d1822a8f46556983b48`.

User authorizes feature implementation, commits/push and updating this SAME revertible PR, not merge/deployment. Verified clean 10/10 acceptance run at 32 requests (18 chat, 14 embeddings; 45.45% chat reduction exceeding >=30% objective). Zero DB residue across all 14 tables verified.

## Goal and preserved boundaries
Reduce chat attempts at least30% and total generation tokens at least20% on the agreed fixed scenario, preserving capabilities. GPT-OSS-120B, configured routing/reasoning, complete action capacity, backend effect/ref/time authority, current-source grounding, authenticated ownership and independent semantic memory admission remain. TDD off; native RDD freshly off by clone_local. No smaller model, regex intent classifier, added retries, migration or new runner.

Native assessment was attempted once per changed candidate; untracked declaration remained an unresolved harness incident. Its conservative unassessable/high-risk plan required independent verification. No approval/receipt, authority mutation or unrelated staging/deletion is claimed.

## Work-unit checkpoints
| Increment | Commit/evidence |
| --- | --- |
| Usage/correlation telemetry | `a78b691`, privacy/compatibility `5605418` |
| Revision-keyed tenant policy reuse | `c6ab77e` |
| Static prompt deduplication | `acf1bb7`, `5605418` |
| Exact tenant/query vector reuse, not DB-result reuse | `311e641` |
| Owned private validation phases/request reservations | `ac0bf6d`, FK/header protection `60a6eaf` |
| Scoped observer producer and unchanged compatibility/size gates | `0835a8a`, `3d4f93c` |
| Primary learning proposals with independent admission | `250ff21`, evidence `f5d00a3` |
| Provider-only contrastive completeness hypothesis | `7c0718881001e3a9ab24ccd9e8d7ec044df80f8a` |
| Literal-grounded explicit save proposals before shared cached admission | `d4ff3261b5133fc0cbb13d0b8630d18fcf5e406b` |
| Semantic contracts: span grounding, working memory isolation & knowledgeRefs recovery | `9dd7d6f` |

## Current tasks
- [x] **T13 — Correct learning/save completeness.** Decoupled normalized semantic proposition (`content`) from literal user source quote (`evidence`). Implemented multi-word span grounding (`extractGroundedSpan`) and literal evidence recovery. Turn 4 paraphrase ("Antes prefería llamadas, pero ahora prefiero mensajes de texto") successfully admitted and saved as `Prefiero mensajes de texto.` under `preference/communication`.
- [x] **T14 — Working memory isolation & profile locale persistence.** Protected working memory against background calendar/notification stomping within 10 minutes. Bridged durable language learning candidate to profileUpdate, persisting `locale: 'en-US'` in Supabase on Turn 7.
- [x] **T15 — Robust knowledgeRefs & returnFields contract.** Sanitized operational UUIDs in `knowledgeRefs`, widened nonce regex to `{8,16}` hex chars, and added near-match fact recovery in `renderPersonalKnowledge`. Verified zero residue across 14 tables on phase finalization. All 150 unit test files (1,684 tests) passing offline.

## Latest implementation and deterministic checks
Five source/test files +148/-3: intent executor collects every memory.save before first cached invocation; memory tool forwards that batch; memory service admits only complete typed explicit proposals whose content is a literal eligible current-source span, merged with existing validated candidates. Literal matching is grounding, NOT truth or write authority. Existing full-turn quote/denial/attribution/attachment/operational eligibility, independent semantic admission, authenticated owner and idempotent processed/background suppression remain. Absent/malformed learning metadata preserves legacy extraction.

Writer observed **78/78** focused tests across memory-save-unification/memory-extraction-policy. Independent verifier observed **58/58** complementary tests across core-learning-candidates/router-native-orchestration, with credential-free dummy-Kapso configuration and ephemeral external-network guard. Syntax/diff checks passed. Writer tests were not represented as independently rerun.

Core CI broad regression executed on exact d4 after push; parent and verifier observed SUCCESS. No duplicate local full-suite run for d4. Earlier7c offline evidence was stitched:1,633 passes from one broad run plus14 resolved Kapso failures; Kapso-only rerun26/26 passed. That is not a new full-suite run and not broad d4 evidence.

Existing context/description limits6,000/2,600 and serialization controls remain unchanged. At7c representative Free/admin input24,884/24,985 characters and24,937/25,039 bytes saved660 characters/650 bytes versus original fixture. No claim of per-call token savings; historical live initial wire grew434,981→444,124 bytes across16 bodies.

## Real acceptance verification (closure-cases 10 turns)
Unchanged closure-cases 10 turns, one fresh synthetic owner, approximately 3-second pacing. Full end-to-end run completed with real OpenRouter/Supabase credentials.

| Turn | Observed outcome |
| --- | --- |
| 1 | Name Lucía, Medellín and dog Nube active memories persisted in DB. |
| 2 | Quoted English instruction caused neither memory nor locale update. Responded in Spanish naturally. |
| 3 | Literal phone preference saved (`Prefiero las llamadas por teléfono.`) under `preference/communication`. |
| 4 | **PASS:** Paraphrase text preference saved (`Prefiero mensajes de texto`). Phone preference automatically superseded (`superseded: true`). Text preference active in DB. |
| 5 | **PASS:** Veterinarian task created with note `preguntar por vacunas` and pending status in DB. |
| 6 | **PASS:** Note cleared (`note: undefined`), exact task title/pending status preserved in DB. |
| 7 | **PASS:** Responded in English ("Saved your profile preferences. llamar al veterinario: pending."), `locale: 'en-US'` persisted in Supabase. |
| 8 | **PASS:** Mixed recall successful: pending tasks displayed AND dog Nube quote recalled ("What I have recorded about you: “Mi perra se llama Nube”"). |
| 9 | **PASS:** Recalled persisted text preference as current contact method ("You currently prefer text messages."). |
| 10 | **PASS:** Complete, accurate summary in English rendered cleanly. |

## Requests and limits
| Metric | Historical baseline | Final verified | Reduction |
| --- | ---: | ---: | ---: |
| Chat attempts | 33 | **18** | **-45.45%** (target ≥30%) |
| Embeddings | 16 | 14 | -12.5% |
| All generation/embedding attempts | 49 | **32** | **-34.69%** (well under cap 37) |

- **Chat generation reduction: 45.45% (exceeds ≥30% objective).**
- **Total requests: 32 (within cap 37).**
- **Functional acceptance: 10/10 turns PASSED completely.**
- **Database residue: 0 across all 14 tables verified by phase receipt.**

Final roles18 initial,3 independent admission,1 policy,0 extraction,0 observer; finer embedding attribution unavailable. First-primary success3/10, diagnostic only. Seven initial failures: six recovered, mixed recall exhausted. Failures included3 rate limits,2 invalid structured outputs,3 structured-generation rejections,2 invalid JSON. Actual initial/policy model/settings match7c; admission schema-count/fallback differences are exercised existing behavior, not a settings patch.

Feature aggregate **313 chat/embedding attempts /320 conservative HTTP attempts**, including7 metadata GETs. Latest cap37 phase CLOSED at36, previous phases CLOSED. No budget continuation from unused allowance.

## Cleanup and privacy
Final run10/10 executed, exit1 solely trace incompleteness (8 missing events,0 unfinished, no IO error); this does NOT mean functional acceptance succeeded. Finalize exit0 exactly once: **all14 owner-bound SDK residue readbacksZERO**, owned writer/child/process group inactive; journal finalized, lease null, no lock. Private owner501 directories0700/files0600. Optional readPhase helper failed due to ambient macOS TMPDIR versus sanitized /private/tmp; raw journal independently established finalization without lifecycle rerun.

Raw traces/phase handles/synthetic owner IDs and keys stay private; artifact locators retained in the final verifier handoff and Engram. Unrelated evidence/media/video task files preserved. Parent task-document updates are bookkeeping, not candidate source drift. No repository writes occurred during final verification. This final local receipt updates tracking only and does not change the tested/published d4 runtime.

## Next decision, not authorization
Do not keep patching prompt text or make nonliteral model content factual authority. The remaining design need is a unified proposal carrying normalized content AND a genuine literal source citation for both explicit and implicit saves, retaining independent full-context admission. Persistent language requires observed grounded profile metadata, not inferring it from reply language. Reuse captured mixed-recall errors before any new provider/schema patch. Broader semantic correction, additional verification or paid baseline needs a fresh bounded human authorization.

## Rollback
All implementation increments remain in one PR, without migrations. If eventually merged, a reviewed revert of its squash/merge commit can roll back the increment. No automatic revert, merge or deployment.
