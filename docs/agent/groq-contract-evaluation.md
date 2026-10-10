# Reproduce the Groq contract comparison offline

T4 adds a console-only, offline-default **schema-only** comparison. Both arms use
the same current Hermes prompt, canonical inputs, request builder, phase schemas
and validators; only the initial provider projection comes from trusted local
baseline `1290e81` in the baseline arm. The report labels this explicitly as
`mixed_source_schema_only`, not an entire historical-runtime comparison. It uses
actual Hermes functions with
owned **fake** contexts. It does not import production evaluation drivers, DB,
Google authentication implementations, dotenv or application servers.

## Quick path: no inference or credentials

```sh
node --experimental-vm-modules scripts/evals/groq-contract/runner.js --dry-run --baseline-ref=1290e81
node --experimental-vm-modules scripts/evals/groq-contract/runner.js --dry-run --baseline-ref=1290e81 --pairs=50
```

Omitting `--dry-run` still defaults to dry-run. The report contains actual
serialized UTF-8 body/message/schema bytes, source commits and per-file hashes,
schema/policy versions, synthetic canonical decisions, independent assertions and
in-memory mock receipts. **Attempts are zero; native usage, cost and latency are
unknown**, not generated statistics. The forecast reserves each complete wire
body using one input-token budget unit per UTF-8 byte, plus the actual 8192/4096
maximum output limit. This conservative reservation is not a tokenizer or a
measured native prompt-token count. No private hashes are uploaded as metadata.

`--repetitions=N` repeats the fourteen fixtures; `--pairs=N` takes precedence and
requests an exact pair count, cycling those fixtures. The report includes counts
per case: fifty pairs give three or four occurrences per case, not an exactly
uniform distribution. Baseline/current order rotates AB/BA by case and
repetition. Fifty fixed-context pairs forecast 100 attempted generations; this
does **not** authorize those calls or promise their native tokens, quality or
latency. The prior paid allowance is exhausted. Any paid comparison needs a fresh
user-approved budget.

## Comparison and authority boundaries

| Boundary | Implementation |
|---|---|
| Request parity | `request-payload.js` is shared by the real client and harness. Existing mocked fetch-body checks and all T3 byte/hash checks remain. Production deadline placement, routing, captures, counters and lifecycle are unchanged. |
| Validation | `foreground-turn-validation.js` contains the actual no-owned-history sanitizer and current-user profile-source enforcement. Named router wrappers preserve initial callback and defensive follow-up behavior. Approval/continuation use their actual parsers and validators, not TurnIntent validation. |
| Trusted baseline | Local hexadecimal commit ref resolved to a validated 40-character commit before `execFileSync`/`git show`; no shell, checkout, worktree, remote fetch or temporary baseline files. Only the `1290e81` provider projection is substituted. Current canonical full identity and all four description-stripped provider fingerprints are checked before comparison. The exact legacy wire extractor is retained only for parity tests, never as a historical client execution path. |
| Policy provenance | Each file records origin/ref/hash. The policy digest includes current core-prompt source, response policy, router language guards, domain-call/executor clarification guards and language detection. Effect-owning guard modules are hashed read-only, never evaluated. Current English locks are therefore shared between both arms, rather than silently confounded with schema compaction. |
| Virtual modules | Static named-import/export adapter with explicit pure-module allowlist, deny-by-default imports and explicit identical synthetic Google/entity adapters. The VM is **not a security sandbox** for malicious source. Regex extraction is intentionally fragile: changed layouts fail closed and require review. |
| Fixture clock | `2026-10-08T16:30:00Z`, local 11:30 in `America/Bogota`; owned fake IDs, task descriptions, literal source origins and preferences. Dates are checked as actual typed year/month/day components, not invented `date` fields. No backend calendar arithmetic or persisted execution is claimed. |
| Structural checks | Known fixtures are completed with nulls from the actual provider schema and checked with the repository's `matchesSchema` subset, then actual canonical validators. This is not a complete JSON Schema implementation or Ajv substitute; existing structural schema tests remain authoritative. |
| Safe artifacts | Retain allowlisted decision structure, targets, schedules, source/selection metadata, native billing identifiers, assertion outcomes and fixture-only projections. Freeform error envelopes, headers, raw prompts/history, failed-generation text and model-invented strings are never retained. Known live keys are scrubbed from identifiers and decision strings. |

The fourteen scenarios cover greeting; no-history personal recall; tomorrow with a
missing clock and its 3 PM continuation; AM/PM ambiguity; explicit calendar
components; the second owned task's **description**; complete status/description
projection; a live agenda read beside a malicious quoted deletion; independent
lasting English preference, dog fact and task read; destructive preparation and
cancellation; plus an English-profile reminder and its neutral `4:45` continuation
beside old Spanish history. Both English fixtures use the current mandatory
English prompt lock. `task.list` uses an actual permitted title/container filter, never
`contextRef`; mutations retain the backend's own reference restrictions.
`time`/`main_time` alternatives are accepted only where the actual contract
accepts them. An already-recorded preference/fact need not be redundantly saved.
Generated acknowledgements never prove execution or persistence.

### Reminder semantic grading correction

Canonical validity is necessary, not proof that a decision preserves the requested
subject or complete clock. Grader-only `REMINDER_EXPECTATIONS` has literal owned
date/subject expectations and `owned-reminder-semantics-v1` provenance. It is not
part of fixture text, context, wire schemas or model messages; no alias guidance
is sent to the model.

| Assertion | Actual grading boundary |
|---|---|
| `reminder_subject` | Effective create content/title, or continuation delta merged with the owned pending subject. Absent delta content preserves the parent; changed content is checked. |
| `date_year`, `date_month`, `date_day` | Actual `resolveTypedSchedule` with the explicit owned reference time/timezone; continuation schedules use actual `mergePendingSchedule` first. Equivalent calendar/relative date representations and inferred current year are accepted when they resolve correctly. |
| `clock_hour`, `clock_minute`, `clock_mode` | Independent resolved 15:00 assertions plus unambiguous PM/24-hour representation. Omitted minute can infer zero through the actual resolver; 15:59 cannot pass. Explicit 3 PM and 15:00 representations are accepted where the contract allows them. |
| Pending/ambiguous clocks | No invented hour/minute/mode for missing time. AM/PM ambiguity remains explicitly represented; date checks do not turn an inferred date-only probe into an execution receipt. Explicit all-day replacement is rejected. |

Declared Spanish subject aliases: `Llamar al dentista`, `Llamar a mi dentista`,
`Llamar al odontólogo`, `Recordatorio: llamar al dentista`. Declared English aliases:
`buy the costume`, `purchase the costume`, `Reminder: buy the costume`.
Matching only ignores case, diacritic marks, repeated whitespace and the finite
punctuation set `.,:;!?¿¡"'“”‘’()[]{}`. No prefix stripping, fuzzy matching, quotation
authority or generated model judgement is inferred. Undeclared paraphrases fail
the acceptance gate with an explicit **unresolved** subject assertion, not a claim
that the backend performed a wrong action. Declared aliases are retained safely
for post-review but never expand from chain-generated strings.

The correction observed **13 failed / 75 passed** before the grader fix, including
the verifier's three canonical-valid probes: continuation 15:59, an unrelated
dated-reminder subject, and an unrelated missing-time subject. All negative
semantic probes assert actual canonical validation succeeds before checking the
grader. Positive coverage includes declared aliases, absent continuation content,
PM alternatives, inferred zero minutes and equivalent anchored calendar dates.
Canonical validators do **not** own runtime language resolution. A callback-first
`structuredIntent` regression verifies that the user language guard and English
clarification sanitization remain intact; the unchanged user
`dynamic-language-resolution.test.js` is also run. The harness itself does not
execute domain tools or certify backend question sanitization.

### Fixed snapshots versus chains

The default `--mode=fixed` compares identical supplied context snapshots, including
predeclared synthetic suspended-run snapshots. These isolate wire compaction;
continuations do not claim that another evaluated model turn succeeded.

`--mode=chain` instead derives deterministic mock pending drafts from **each
variant's actual valid, semantically correct decision**. A failed parent stops
dependent children (`parent_failed`); no successful history is fabricated.
Divergent or missing contexts are marked unmatched and excluded from paired byte
and native prompt-token deltas. All effects remain in memory. Mock receipt
projections distinguish actual fixture `description`/`status`, null/absent data
and unknown fields; they are not persisted backend checks.

## Future paid execution: disabled unless explicitly requested

The implemented live path requires all of:
`--live --max-generations=N --max-cost-usd=X --explicit-known-pricing`.
Flags and positive finite budgets are validated **before credential lookup**.
Only caller-provided `OPENROUTER_API_KEY` is read, after that validation; no dotenv
or key files are loaded. No credits/account inspection occurs. The API host is
fixed to OpenRouter; the route is hard-pinned to GPT-OSS-120b/Groq with provider
fallbacks disabled, temperature 0, medium excluded reasoning, no tools/web,
8192 initial / 4096 suspended-response limits, and a 6000 ms deadline.

No retries or alternative providers exist in this harness. Every POST attempt,
including HTTP 400/429 and timeout, consumes the shared run generation cap.
Hard CLI ceilings are 100 attempted generations and $5. Before POST, the ledger
reserves full wire-byte input at $0.15/M plus a full-size $0.15/M cache-write
contingency, and maximum output at $0.60/M; no cache discount is assumed.
These are **explicit known-price assumptions**, not freshly queried prices or a
guarantee against changed upstream billing. Reconfirm them with the future budget
authorization. Verified numeric `usage.cost` replaces its own reservation;
missing/invalid costs remain reserved, including failed attempts. There is no
automatic generation-detail lookup or assumption that failures are free.

Results retain safe HTTP status/code/provenance (including HTTP-200 error-only
envelopes), actual generation/request IDs when safe, native prompt/completion,
reasoning/cache-write/cache-read counters and cost when present. Missing counters
remain null. Correctness requires actual validation and case assertions by the
deadline. Response-latency medians include only correct accepted decisions;
errors have separate counts, and there are no small-sample percentiles. Native
prompt-token deltas require a matched pair with both actual counters.

Evidence writing is optional and **live-only**: a new
`--output=odd/evidence/groq-contract-evaluation/<run-name>.json` file. Path escapes,
nesting, symlinks and overwrites are rejected. This implementation/verification
writes no real evidence artifacts; output remains console-only.

## Offline verification

```sh
npm run test:unit -- tests/unit/agent/groq-contract-evaluation.test.js tests/unit/agent/provider-latency-regressions.test.js tests/unit/agent/structured-protocol-responses.test.js tests/unit/agent/core-learning-candidates.test.js tests/unit/agent/router-structured-boundary.test.js tests/unit/agent/runtime-model-contract.test.js tests/unit/agent/provider-description-compaction.test.js tests/unit/agent/dynamic-language-resolution.test.js
npm run test:unit
```

The initial required foreground baseline passed 154 tests in five files. The new
test-first suite failed before production edits because the shared request module
did not exist (one failed suite, no collected tests). Subsequent checks exercise
actual builders/validators, strict fixture shapes, import isolation, zero-key/
zero-network dry-run, AB/BA pairing, budget reservation/caps, typed failures,
chain parent stops, owned projections and safe decision retention using fake
fetch only. This is not live schema acceptance, quality or latency evidence.

After the user's language commit `106f28f`, the fresh eight-file foreground
baseline passed **218 tests**. New resume regressions observed **4 failed / 44
passed** before fixes: the baseline lost the English lock, policy hashing ignored
the lock, source/setup failure classification was incorrect, and output-path tests
could not isolate their workspace. Earlier receipts do not certify the resumed
snapshot.

The resumed focused gate passed **236 tests in eight files**. The required dry-run
passed all fourteen fixture pairs (28 synthetic decisions), with zero attempted
generations. A fifty-pair fixed-context dry-run passed all 100 fixture decisions,
reported 61,600 total saved wire bytes, and forecast a conservative maximum
reservation of **$1.159516217** under the explicit price assumptions above.
That forecast is not actual billing or permission to execute. Its real native
usage and latency remain unknown. The English-profile fixture measures
26,188 → 24,648 request bytes with identical 6,786-byte messages in both arms.

## T3: provider-description compaction evidence

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

## Historical T3 measured UTF-8 bytes

Fixed synthetic messages: initial prompt from `buildAgentCorePrompt` with
`nowStr="2026-10-01 11:30"`, `nowHumanStr="Thursday, October 1, 2026"`,
`timezone="America/Bogota"`, `language="en"`, empty memory, no overview, and user
text `List my tasks.`. The same non-admin messages are used in every row to
isolate schema differences. At T3's original snapshot, messages serialize to **5,511 bytes** before and
after. The body uses the production outer `response_format.json_schema` wrapper,
model `openai/gpt-oss-120b`, temperature 0, max_tokens 8192, stream false,
medium/excluded reasoning and Groq-only routing.

The user subsequently added an English prompt lock in `106f28f`; do not reinterpret
the historical table as current absolute bytes. The same current English fixture
now measures **5,776 message bytes** and **25,178 → 23,638 full request bytes**
(normal non-admin), still saving **1,540 bytes** solely from schema descriptions.
Current admin normal measures 25,194 → 23,654; either attachment-only variant
measures 11,518 → 11,032. All original structural hashes and byte-reduction checks
remain; the current harness prints its own complete fixture-wire measurements.

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
deferred. T4 is available offline as described above; any paid comparison requires
fresh authorization and a new explicit budget. No publishing or paid calls are
part of T3/T4 implementation.
