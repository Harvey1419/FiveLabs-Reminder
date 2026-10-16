# First-turn decisions and the last pending clarification

V2's canary and fluent evaluator enable `productivityDecisionPolicy`. The numeric production budget is unchanged: input 2500, output 2048, total 20000, 10 model steps, 10 tool calls, 45 seconds and a 256-token read-continuation reserve. Decision controls and schema selection count against those limits; they never execute domain operations.

## Declare, propose, verify

`conversation_decide` declares ready item keys and authorized tool names, optionally one incomplete item. Every corresponding fresh domain call supplies `decisionItem`. A declaration can accompany its ready calls when their schemas are advertised. Otherwise declare first, select the missing schema separately, then propose the calls. The host checks the complete sibling batch before journal/dispatch and strips control metadata before domain validation/execution.

For the current request:

> Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana

A correct declaration is:

```json
{
  "ready": [{"key": "meeting", "tool": "reminder_create"}],
  "pending": {
    "tool": "reminder_create",
    "missing": "today_or_tomorrow",
    "knownArguments": {"content": "Enviar informe", "relativeDayTime": {"hour": 9, "minute": 0}}
  }
}
```

Ambiguity belongs to the individual item, not the whole request: the meeting is ready and only the report is pending. Do not put a question in `reply` alongside `pending`; the host generates the pending question after verified ready effects. The native tool schema intentionally uses simple transport shapes, without `not` or semantic string/cardinality restrictions. Groq validates this schema before returning a tool call; overly strict native constraints can turn an incomplete model proposal into a provider error before the host can handle it. `knownArguments` is optional only on this transport boundary. `DecisionSession` still applies the strict runtime schema: nonempty/non-whitespace dialogue, exclusion of `reply` with ready work/pending/resolution, at most ten valid unique ready keys, and required pending facts. A native omission is not permission to execute, persist or accept an incomplete declaration.

A declaration-only response is not completion. Its host acknowledgement includes `execution: false`, `remainingReady` keys and a request for fresh real tool calls. Emit those calls alongside the declaration when the schemas are available, or on the next model step. If the model instead stops with declared work outstanding, the harness permits one accounted continuation with an explicit remaining-key hint. It never constructs a call from a declaration, replays a verified key or accepts another premature closure. Existing authorization, journal, reconciliation and budget checks still apply.

For a fresh `reminder_create` pending item with a date uncertainty (`date` or `today_or_tomorrow`), `knownArguments` must retain nonempty content and an integer local hour/minute (0–23/0–59). One exhaustive classification of supported missing-field labels drives admission, bounded correction and date-only resolution; adding a label requires explicitly classifying it at compile time. `time`, `item` and `details` remain distinct, rather than silently becoming date aliases. An empty or incomplete object cannot be admitted or persisted as a day-only question. A standalone incomplete declaration, including one that omits `knownArguments` at the native boundary, may receive one fresh, accounted correction; the rejected control consumes the tool-call budget but executes nothing. A validation-only probe recognizes the omission; admission always reparses the original model arguments. No probe or synthesized empty object is admitted, persisted or executed. Malformed sibling batches fail before any dispatch. This does not rewrite legacy checkpoints or synthesize missing facts from text.

The fresh meeting call uses `decisionItem: "meeting"` and `relativeDayTime: {"day":"today","hour":16,"minute":0}`. Only its verified outcome permits the pending question: **¿El recordatorio pendiente es para hoy o para mañana?** A plan is not a receipt. Failed, uncertain, aborted, unauthorized or incomplete effects do not satisfy declared readiness. Mark the final completing batch call `turnDisposition: "finish"`; use `continue` when analysis/dependencies remain. Read-with-analysis must not be auto-closed merely because the read succeeded.

## Persist facts, not commands

The existing owned conversation/checkpoint stores at most one `pending` object: host-generated identity, owner, source request, host source time/timezone, proposed tool, typed missing field and bounded partial known arguments. This is not a queue, executable command template or permission grant. Existing checkpoint recovery, uncertainty reconciliation and delivery guards remain authoritative.

A current answer such as **mañana** needs a new decision with `resolution.pendingId` exactly matching the host-issued `lastPending.id`, one ready item and a fresh domain proposal. The proposal preserves the known content and 9 AM. Resolving a reminder's date uncertainty, whether labeled `date` or `today_or_tomorrow`, may add only the missing `relativeDayTime.day`, not recurrence or delivery options. Both variants reject changed or dropped known content/hour/minute before dispatch. The original verified meeting is not replayed. Only verified resolution consumes the pending state; unrelated conversation retains it and a newer valid clarification replaces it.

For example, the second-turn declaration is:

```json
{
  "ready": [{"key": "report", "tool": "reminder_create"}],
  "resolution": {"pendingId": "<host-issued lastPending.id>", "key": "report"}
}
```

Omit `reply` entirely, rather than sending an empty string. Propose only the fresh report call with `decisionItem: "report"`, its preserved content and `relativeDayTime: {"day":"tomorrow","hour":9,"minute":0}`; do not repeat the meeting.

Relative facts retain their source frame. A changed timezone, changed local calendar day or incompatible duration anchor rejects resolution before effects instead of silently rolling a date forward. Source-less legacy relative pending facts also fail closed on resolution; a fresh explicit clarification/request is needed. Legacy conversations without pending state remain readable. Forgotten facts are scrubbed from the model's pending projection without rewriting durable reconciliation data.

## Dialogue and compatibility

Pure conversation uses `ready: []` with `reply`, without domain actions. Non-authorizing controls can be advertised for attachment-only dialogue, but attachment text/location labels still cannot authorize domain tools.

Complete current legacy calls without typed metadata retain their existing validation/authorization path. This bridge never synthesizes a plan from history. An explicit decision, stored pending or a host-forced initial-decision correction requires typed validation. Initial unstructured no-call prose can receive one fresh, accounted, no-effect decision request within existing limits; rejected provider arguments are never executed or replayed. An accounting lock prevents every subsequent evaluator provider step, including correction.

## Verification boundary

- `first-turn-decision.test.ts`: public runner constraints, observed declaration-only/premature-stop recovery using fresh real calls, retained content/clock boundaries, bounded corrections and charged control limits, verified-sibling replay rejection, exact mixed request/JSON reload, ownership, abort, uncertainty, missing-field/provenance/privacy guards and read analysis.
- `first-turn-decision-durable.test.ts`: real adapter/runner/checkpoint/presenter composition with **mocked HTTP**, including persisted pending and its consumption.
- `budget-policy-coherence.test.ts`: public offline budget scripts with the active decision policy, actual advertised-control evidence, typed capacity cases and unchanged negative controls. The comparison script retains its narrower historical probe caps; its reported production policy is not a claim that those probe caps equal production.

The host verifies **declared** readiness, not whether the model recognized every user intent. Scripted proposals cannot establish future model classification, live acceptance, billing reconciliation or WhatsApp delivery. Historical failed live evidence remains failed; another inference run requires separate authorization. See [local time semantics](v2-mixed-temporal-semantics.md) and [bounded evaluation](v2-fluent-evaluation.md).
