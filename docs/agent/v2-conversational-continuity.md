# V2 conversational continuity

V2 keeps working conversational context separate from execution evidence. A saved transcript alone is insufficient: the next model request must retain the referents and preceding exchange needed to interpret a short follow-up.

## Context carried into the next turn

| Context | Source and boundary |
| --- | --- |
| Ordinal identities | Existing host-owned `referenceOrder`, backed by known records and bounded by `maxPromptReferences`. Available before a mutation schema is selected; historical, not a fresh inventory. |
| Preceding dialogue | One prior user request and its final non-tool assistant reply. If compaction omits that exchange, include a verbatim historical projection of at most 800 characters per message, with explicit truncation. |
| Final response | The durable adapter stores the host-rendered reply in both its completed checkpoint and returned conversation. It replaces final assistant prose, never tool calls or results. |
| Execution state | Structured tool observations, journaled outcomes, ownership, capabilities and reconciliation checks remain authoritative. Dialogue cannot authorize a mutation or certify success. |

Forgotten-memory redaction runs before historical dialogue projection. The projection is included in input-budget calculations; it does not bypass limits. An exchange already retained in the model transcript is not duplicated.

For example, after a five-record reminder list, `Elimina el 1, el 2, el 3 y el 5.` can refer to the stored ordinal identities even when only create schemas are initially advertised. After a clarification, `Si son recordatorios que quiero eloiminar` can retain its preceding request and question. After an honest failure reply, `por que ?` has that reply available as conversational context.

## Delivery and safety

A reply in a `ready` checkpoint is prepared dialogue, not proof of delivery. `attempted` and `unknown` sends still require existing reconciliation; `accepted` means transport-provider acceptance, not handset receipt. This change adds no automatic send or uncertain-write replay.

Unknown resource IDs mentioned in prose do not become owned references. Cancelled/deleted/forgotten resources retain existing dispatch restrictions. Unchecked model success narration is not exposed in place of verified execution cards.

## Mixed operations and pending input

After verified operations, the reserved `conversation_clarify` tool can request missing input. It accepts only `{ domain, missing }`, never question text or execution claims:

- `domain`: `reminders`, `tasks`, `calendar`, `memories`, `general`.
- `missing`: `date`, `time`, `item`, `details`, `today_or_tomorrow`.

The host advertises this channel only after nonempty, successful, complete results with no unconfirmed calendar companion or uncertain effect. It is absent from the initial schema scope. The model must call it alone with empty content, after marking preceding operations `continue` rather than `finish`. The loop validates the entire decision before changing the transcript or dispatching anything; it appends a paired non-execution observation and stops for user input. Existing cancellation, accounting, time, token and call limits still apply. Clarification itself creates no domain operation, execution receipt or authorization.

The presenter renders an English or Spanish question selected from these enums below the verified cards. For `reminders` / `today_or_tomorrow`, Spanish output ends with `¿El recordatorio pendiente es para hoy o para mañana?`. It suppresses whole-request success acknowledgements while input is pending, deduplicates matching presentation questions, and reserves space for the question within the existing 4000-character message bound. Old payloads without clarification metadata retain their behavior. Failure/uncertain-result handling and arbitrary-prose suppression remain unchanged.

For example, one request can create the first reminder and ask whether the second is today or tomorrow. The next `mañana` receives the prior request, host question and structured operation history as context. Only the remaining reminder should be created; historical dialogue is still not authorization to replay the first write. A scripted regression verifies this seam, not the model's interpretation of it. There is no host intent detector: if a model incorrectly declares `finish` or ignores the advertised clarification channel, these changes cannot establish that all requested work was fulfilled.

## Verification and limits

After building workspace packages, run:

- Unit configuration: `tests/unit/agent-core/conversational-context.test.ts`, `durable-productivity-assistant.test.ts`, `typed-clarification.test.ts` and `mixed-clarification-presentation.test.ts` in that directory. These cover context, checkpoint/delivery boundaries, strict tool validation, authority fences and bounded presentation.
- Conversation integration configuration: `tests/integration/agent/v2-mixed-clarification.integration.test.ts`. This uses the actual runner, durable adapter and presenter with simulated provider/persistence/delivery ports. It asserts exactly two writes across two turns, tomorrow's local time, both retained records, checkpoint/reply consistency and a valid tool transcript.

These are deterministic tests, not proof of live-model interpretation, provider availability or WhatsApp delivery. The changes do not raise input budgets, broaden provider recovery or change long-term personal-memory retrieval. Free-form model prose remains suppressed for execution items.

### Controlled real-provider acceptance

Before paid inference, agree on an explicit total call cap and USD spending cap. Use synthetic requests and records with in-memory domain/journal/delivery ports, never production persistence or WhatsApp. Select the existing configured provider only after that authorization, enforce per-request loop/cost limits within the total cap, stop on exhausted or unaccounted spend, and do not retry uncertainty to manufacture a pass.

The minimum case is the same first-reminder / pending-day / `mañana` sequence, but with actual provider decisions rather than scripted calls. Record the model/version returned, call counts, reported usage/cost, each response and verified synthetic effect, then compare timestamps, no-repeat counts and the missing-input question. A failed, unavailable or over-budget run is an unresolved acceptance result, not permission to raise budgets or publish. Production writes, deployment and WhatsApp validation remain separate authorizations.
