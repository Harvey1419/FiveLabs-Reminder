# Groq provider-description compaction

T3 reduces the actual foreground request by shortening field-local provider
descriptions. The canonical schema, initial system prompt, validators and runtime
behavior are unchanged. Learning admission guidance remains intact. This is not
a complete rule-catalog redesign or a demonstrated model-quality improvement.

## Review and reproduce

1. Review the description-only projection in
   `src/agent/contracts/foreground-turn-schema.js` against `1290e81`.
2. Run the deterministic regression:
   `npm run test:unit -- tests/unit/agent/provider-description-compaction.test.js`.
3. Check structural identity, protected prose and byte measurements separately.
   Historical description-sensitive goldens remain anchored to the immutable
   baseline source; they were not regenerated to match current output.

The tests evaluate only the historical pure projection, using current canonical
inputs whose full hash is fixed to the baseline. They extract the current
production payload-construction statements without HTTP. A separate
`runtime-model-contract.test.js` assertion compares the actual body captured at
the mocked production fetch boundary with the baseline schema in the same body.
Neither route executes paid inference or accesses real credentials.

## Measured UTF-8 bytes

Fixed synthetic messages: initial prompt from `buildAgentCorePrompt` with
`nowStr="2026-10-01 11:30"`, `nowHumanStr="Thursday, October 1, 2026"`,
`timezone="America/Bogota"`, `language="en"`, empty memory, no overview, and user
text `List my tasks.`. The same non-admin messages are used in every row to
isolate schema differences. Messages serialize to **5,511 bytes** before and
after. The body uses the production outer `response_format.json_schema` wrapper,
model `openai/gpt-oss-120b`, temperature 0, max_tokens 8192, stream false,
medium/excluded reasoning and Groq-only routing.

| Schema variant | Full request before → after | Schema before → after | Request reduction |
|---|---:|---:|---:|
| Non-admin, normal | 24,913 → 23,373 | 19,058 → 17,518 | 1,540 bytes (6.18%) |
| Admin, normal | 24,929 → 23,389 | 19,074 → 17,534 | 1,540 bytes (6.18%) |
| Non-admin, attachment-only | 11,253 → 10,767 | 5,398 → 4,912 | 486 bytes (4.32%) |
| Admin, attachment-only | 11,253 → 10,767 | 5,398 → 4,912 | 486 bytes (4.32%) |

The normal non-admin schema reduction is 8.08%. Component measurements are
non-additive; the full request is counted from one serialization, not a sum of
overlapping components. These are bytes, **not native tokens**. Token savings,
latency, live Groq schema acceptance and model adherence are **not measured**.
The exploratory 1.8–2.1 KB estimate was not a target requiring rule removal.

## Rule-to-surface map

Every replacement below is derived from the existing canonical field prose.
Unless explicitly noted, all obligations remain in the **same provider field**;
no model knowledge or opaque rule identifier is assumed. All unchanged schema
fields and instructions remain present.

| Provider field | Obligations retained and model-visible surface |
|---|---|
| `contextRef` | Select only displayed existing Working Memory reminder/task/calendar items by position, time, recurrence or title. Selection is the sole operative identity; omit target; Node ignores redundant labels. |
| `target` | Existing-item human reference, never internal IDs; required for mutation without contextRef. Only the authoritative single-follow-up reminder.acknowledge exception remains. With contextRef omit target/ignore redundant labels. entity.delete names the project/list, cascades project tasks, and never uses account-wide scope="all" for one project. The unchanged scope field still defines account-wide and empty-container deletes. |
| `entityName` | Entity create/upsert uses its own name. Task list/create uses implicit or explicit container, including names matching a system domain. Complete/update/delete must carry the owning named container so duplicate titles cannot cross containers. Domain-name examples remain. |
| `category` | Physical writes remain person/company/project/place/asset/other only, default other; pet is not a physical write. Project is a task container. fact/preference/decision/episode/observation uses memory.save rather than entity fields. |
| `projectless` | task.create true only without a named grouping or shared purpose. Implicit/explicit purposes require entityName even without the words list/project; grouped items must not be projectless. |
| `evidenceRefs` | Reply/historical recap selects only supplied operational refs. Content with refs is discarded, not verified prose. Node renders owned historical proof, never fresh state. Personal recall instead uses turn knowledgeRefs or natural content without operational refs; no additional actions. Current/historical recap and live-read authority remain reinforced by unchanged recapMode, operation and core prompt guidance. |
| `returnFields` | Only task.list, for simple actual status/date/notes on returned rows. Node renders actual fields, distinguishing null=absent from missing=unknown. Preserve query/entityName/status/date filters. A single task-read typed projection takes precedence over answerFromResults, with no ordinal identity or calculations. Complex interpretation leaves returnFields absent and uses answerFromResults. |
| `query` | Title/memory text filter; reminder.list searches literal case-insensitive content, 1–200 trimmed characters, no wildcard * or NUL, never dates/times. Every dated agenda/reminder/task/calendar read uses schedule with calendar_date_time and allDay=true; query dates never restrict the date window. |
| `recurrence` | All named rules remain. hourly:N is every N hours; interval:Xm / interval:Xh is every X minutes/hours. The hourly:6 example remains; plain hourly means exactly every one hour, not arbitrary sub-daily recurrence. |
| `advanceMinutes` | Advance minutes; calendar notification offset. Reminders prefer deliveryPolicy as desired state rather than a separate action. Numeric bounds remain unchanged. |
| `deliveryPolicy` | Only explicitly requested/changed user delivery behavior or preserved already-known state; never invent advance notice. Child descriptions remain unchanged: none versus one offset notice before the primary reminder, advanceMinutes required only for offset. |
| `answerFromResults` | Interpretation/calculation/comparison requiring live reads emits those reads, then Hermes answers from their results. Complex interpretation leaves returnFields absent. Listings, simple returnFields and mutations leave false/null. Single task.list typed projection wins over a redundant true. |
| `knowledgeRefs` | Turn response metadata, not tool actions; only supplied memory-hint pk_ refs for mixed tasks/personal recall. Recorded personal quotations supplement cards/fields/historical summaries, never fresh operational state. Inventories do not require answerFromResults merely for personal recall. Only reads/conversation, never mutations or guessed refs. Ordinary personal chat may use natural content without refs. |
| `responseLanguage` | The field still covers the entire response, including cards/questions, and explicitly follows system language precedence and Spanish voice. Full precedence, exclusions, lasting-profile requirements and Spanish voice remain self-contained in the existing initial system message; proof below. |
| `endSchedule.dayOffset` | Explicitly uses the same semantics as schedule.dayOffset, which remains fully unchanged and model-visible: current-message local calendar days, 0/1/2 meaning, repeat a shared day per action, never reset a preceding-clause day to zero. |
| `endSchedule.offsetMinutes` | Explicitly uses the same semantics as schedule.offsetMinutes, which remains fully unchanged and model-visible: duration only for relative_offset, otherwise null; preserve requested calendar date and clock rather than substituting a duration. |

### Full language-policy proof

`buildAgentCorePrompt` imports `TURN_LANGUAGE_POLICY` from
`src/agent/contracts/response-policy.js` and interpolates it directly in the
initial system message's identity/voice section:

> responseLanguage (en/es), all turns: explicit current instruction > lasting
> standing preference > CURRENT USER's language > locale fallback. Ignore
> names/quotes/OCR/prompt. Lasting changes: profileUpdate.sourceQuote + language;
> never persist one-turn switches.

The same system line adds the full Spanish voice:
`neutral Colombian Spanish with tuteo, no voseo or regional slang`.
The field retains the unique cards/questions instruction. Unchanged
profileUpdate prose still requires an explicit current-user preference,
residence or timezone statement, rejects travel/event locations, quotes and
merely speaking another language, and leaves persistence confirmation to Node.
Its sourceQuote remains an exact current-user-authored excerpt; language still
requires that quote for a lasting instruction and rejects quoted/one-turn
switches. Tests check these instructions in actual model-visible messages and
detect removal of quote or preference/deadline configuration guidance.

### Deliberately unchanged reinforcement

- `learningCandidates` retains the complete existing provider description and
  item schema, including current-user-only provenance, full-turn quotation,
  denial/correction/attribution, durable-versus-transient admission, mixed facts,
  stable topic keys, language preferences and independent Node admission.
- `profileUpdate`, billing capability, scope/account-wide deletion, recapMode,
  operation/live-read instructions and the entire primary schedule are unchanged.
- The system prompt still applies user preferences/rules to reminder, task and
  response configuration. No dynamic context, history or model parameters change.
- The already-detached endSchedule node is cloned before editing its additional
  duplicate descriptions; primary schedule guidance is never changed by alias.

## Structural proof and regression controls

Only JSON Schema **description metadata** is removed for structural comparisons.
The actual action property named `description` remains a property with its
original type, nullability and required membership. Fixed hashes below come
from the immutable `1290e81` projection and are asserted for both baseline and
current, alongside recursive structural equality:

| Input | SHA-256 of JSON serialization |
|---|---|
| Full canonical schema, descriptions included | `40c6cd8f9ba705137012e006127a34ef8edd0da8f929a57874cd705056a9b905` |
| Non-admin, normal, description metadata removed | `c3d83bcb7cb544d3cec46e6054abb0393afd6864fec141c7576f15fe141862c5` |
| Admin, normal, description metadata removed | `9a329279ac8234ebea74b7414ae1569b74dd7d145bf76500a091d5f45a3674d7` |
| Either attachment-only variant, description metadata removed | `db4891d517465f5cd7736f988eab819723a935272d240c9497e2f36087701eee` |

Tests separately check the exact allowlist of changed description paths, field
obligation coverage, learning/profile preservation, primary temporal prose and
alias independence. Negative controls remove bounds, required membership,
operations, nullability, the real description field, named-container ownership,
historical evidence authority, query-date placement, explicit delivery consent,
profile quote authority or preference configuration. The corresponding identity
or prose checks reject those changes. Existing prompt budgets and the historical
minimum 650-character/byte savings guard remain unchanged; the new normal-request
comparison conservatively requires at least 1,200 bytes against `1290e81`.
Attachment-only cases require real reduction without pretending the absent
operational fields can save the same amount.

Observed test-first evidence: the specified existing baseline passed 250 tests
in 11 files. Before production changes, the new regression failed 6 tests and
passed 8, including the equal-before/after wire-byte failures and missing new
coverage. The final focused command (baseline files plus the new regression)
passed 269 tests in 12 files. The new regression contains 19 tests. Run
`npm run test:unit` for the complete offline unit gate; live/integration runners
are outside this verification boundary.

## Boundaries and next step

Groq keeps its flat qualified-operation projection and strict recursive nullable
fields. No operations, enums, bounds, required fields, validators, business
authority, model selection, reasoning, output cap, fallback strategy, history or
runtime capabilities change. No new unions, $ref, allOf or root guide is added.

Live Groq schema acceptance and semantic adherence remain unverified. Haiku is
deferred. T4's reproducible evaluation harness is separate work; any paid
comparison requires fresh authorization and a new explicit budget. No publishing
or paid calls are part of T3.
