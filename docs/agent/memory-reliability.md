# Reliable personal memory for Hermes V2

Personal memory must represent user-supported knowledge, with traceable ownership and revision history. Exact text matching and a successful model verdict are necessary checks, not proof of truth. This first work unit hardens context boundaries; the persistence lifecycle below remains proposed.

## Verified incident and immediate correction

An active legacy `profile/name` memory attributed another name to the reporter. The reporter's own correct-name memory remained active with a null topic key; the user profile had the correct contact name. The erroneous memory predates V2 extraction. Its exact owned row was administratively retired with `is_active=false` and `valid_until`; the correct-name row was retained. No other user's records were changed. The original extractor's source is not recorded in this row, so its historical attribution error cannot be conclusively reconstructed.

Current code has four reliability gaps:

- Native saves use `confidence: 1` without a calibrated probability or stored provenance.
- Native exact-content hashing handles sequential duplicates, not evolving facts or corrections.
- Existing retrieval rejects topic-less legacy rows and ranks canonical `profile/*` highly; good labeling does not make a claim true.
- The standing reader returns profile facts as well as preferences, and the V2 adapter previously discarded those distinctions and accepted ownerless rows.

## Implemented context boundary

`readPersonalContext` now requires an explicit matching owner, active state, valid category, nonempty identity and valid lifecycle. Inactive, superseded, expired and future records are excluded. The standing reader may return six candidates; prompt output remains bounded to two facts and two preferences, with duplicate text removed. Facts are rendered as personal memories, never behavioral preferences.

Optional personal context also carries guidance: previous assistant replies are not factual evidence; contact display names are labels, not verified identity; conflicting personal claims require clarification. This is behavioral guidance, not a deterministic semantic conflict resolver. The main 1,800-token cap and optional-context timeout remain unchanged.

## Reference ideas and adaptation

| Source | Verified pattern | Hermes adaptation |
| --- | --- | --- |
| [Engram architecture](https://github.com/Gentleman-Programming/engram/blob/main/docs/ARCHITECTURE.md) | Curated capture, scoped topic updates, duplicate/revision metadata and review lifecycle | Stable owner + subject + topic identity, revision lineage and review rather than parallel contradictory assertions |
| [claude-mem repository](https://github.com/thedotmack/claude-mem) | Search compact indices, inspect timeline, then fetch selected observations | Retrieve bounded candidates first; inspect original source and relevant revisions before answering uncertain personal questions |

Both projects target agent/session memory. Their capture policies are not automatically appropriate for personal WhatsApp facts. Hermes should retain user-authored assertions and verified domain outcomes as separate kinds of evidence; assistant paraphrases and tool traces must not silently become personal identity.

## Persistence work units, in order

1. **Source attribution and conservative admission.** Store the source request/message identity, modality, exact evidence offsets and excerpt, asserted subject, admission outcome and policy version. Check ownership against the immutable source before insertion. Represent unknown reliability honestly; model confidence is not a truth probability. Legacy rows without provenance remain distinguishable. Validate first-person facts, spouse names, quotations, corrections, negation, transcription errors and temporary operational state.
2. **Atomic topic revisions.** Use `(user_id, subject_id, topic_key)` identities with stable topics such as `profile/name`; a spouse's name has another subject. Transactionally supersede only a confirmed correction in the same scope, preserving prior evidence. Source/candidate idempotency and a partial unique active-topic constraint must prevent concurrent duplicate writes. Exact-content hashes alone cannot do this. No broad inferred replacement.
3. **Conflict-aware retrieval.** Carry structured source and lifecycle metadata to the context builder. Rehydrate owned rows before use; exclude retired/review-required assertions from confident personalization. Resolve a correction through its source; ask the user when lineage is absent or conflicting. Historical assistant replies cannot re-establish deleted knowledge. Profile facts must not outrank contrary evidence solely because of a topic prefix.
4. **Durable learning and evaluation.** Use an owner-bound background outbox, with cancellation/reconciliation for uncertain writes. Build a labeled ES/EN text/audio corpus and compare actual model outcomes: false admissions, incorrect subject attribution, contradictory active topics, successful corrections, token cost and latency. Scripted success does not certify live semantic quality. No live provider comparison has been run in this work unit.

Each persistence unit requires a reviewed Supabase migration, ownership policies and adversarial integration tests before rollout through GitHub. Existing `valid_until` and `superseded_by` fields should be reused rather than adding a second revision representation.

## Production limits

Only the exact incorrect-name row was retired in production. Other questionable legacy rows were observed, not changed. This context hardening is local until merged/deployed. It does not backfill provenance, repair all legacy memory, or implement the proposed revision/outbox lifecycle. Audit/history can retain the previous wrong assistant answer; deactivating a memory is not an erasure of the conversation transcript.
