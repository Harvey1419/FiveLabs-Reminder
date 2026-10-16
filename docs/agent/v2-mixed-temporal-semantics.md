# Mixed requests and explicit local reminder times

V2 separates missing fields from independent actions that are already specified. A short answer such as `mañana` can supply the missing date of the immediately preceding question; it must not erase an earlier explicit `9 AM`, repeat a verified operation, or activate unrelated historical requests. Full and executable context profiles share this guidance. History and model proposals are not authorization: ownership, capabilities, journal, reconciliation and execution checks still apply.

## Choose the typed time representation

`reminder_create` accepts exactly one scheduling alternative:

| Field | Meaning |
| --- | --- |
| `delayMinutes` | A positive relative duration, preserving the existing behavior. |
| `relativeDayTime` | Explicit `today` or `tomorrow`, plus `hour` 0–23 and `minute` 0–59 in the user's timezone. `9 AM` means hour 9; `9 PM` means hour 21. |
| `targetTimeIso` | An explicit absolute timestamp with a timezone offset, preserving the existing behavior. |
| `unqualifiedLocalTime` | A genuinely undated clock without AM/PM. Existing behavior finds the earliest future half-day occurrence; it must not be used to discard a known day or AM/PM. |

The model supplies structured facts; the host performs timezone/calendar arithmetic. The domain persistence contract remains a single `targetTimeIso`: the new field is model-facing only. Mixing alternatives returns `INVALID_ARGUMENTS` before domain dispatch. For `relativeDayTime`, an invalid timezone/anchor, an unavailable local time, or no future occurrence on the requested explicit day returns `INVALID_LOCAL_TIME` without domain dispatch, records or receipts. Explicit day/time resolution never rolls the requested date forward or flips AM to PM. During a DST fold it selects the first exact matching occurrence strictly after the reference instant; a skipped local clock is rejected.

The fixed test reference is `2026-10-11T17:49:00Z` in `America/Bogota` (12:49 PM local):

```json
{"content":"Preparar reunión","relativeDayTime":{"day":"today","hour":16,"minute":0},"turnDisposition":"continue"}
```

This becomes `2026-10-11T21:00:00.000Z`. After that verified operation, the standalone advertised control can ask for the other action's missing date:

```json
{"domain":"reminders","missing":"today_or_tomorrow"}
```

After the current user answers `mañana`, the remaining proposal preserves the original AM clock:

```json
{"content":"Enviar informe","relativeDayTime":{"day":"tomorrow","hour":9,"minute":0},"turnDisposition":"finish"}
```

This becomes `2026-10-12T14:00:00.000Z`, with no change to the first record. The existing bare input `{"unqualifiedLocalTime":{"hour":9,"minute":0}}` still becomes **today 9 PM**, `2026-10-12T02:00:00.000Z`, at this reference. Those old arguments do not contain enough facts to infer tomorrow 9 AM; the host deliberately does not invent them.

## Verification boundary

`tests/unit/agent-core/mixed-temporal-semantics.test.ts` checks the public tool's conversion, rejection/no-write behavior, old alternatives, DST gap/fold, and actual full/executable model-request guidance. Its offline wire fixture uses the real OpenRouter adapter, runner, durable presenter/checkpoints and budget transport with **mocked HTTP only**; it verifies two records/receipts in separate turns and unchanged first-record state.

These tests prove deterministic handling **when the model proposes the typed facts correctly**. They do not prove the model will make that choice. There is no keyword-specific text parser or autonomous action queue. Temporal conversion itself adds no state; the separately authorized [first-turn decision protocol](v2-first-turn-decisions.md) now persists one typed clarification in the existing owned conversation/checkpoint. The failed real probe in `odd/evidence/v2-directed-conversation-2026-10-15.json` remains failed historical evidence, not rewritten as a success. No new live proof or billing reconciliation follows from an offline pass. See [bounded evaluation](v2-fluent-evaluation.md) for separately authorized live runs.
