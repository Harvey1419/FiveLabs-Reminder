# V2 compound requests with a 2,500-token input budget

V2 now uses 2,500 estimated input tokens per model request. This is a cost/context policy, not the model's native context window or the whole-turn total. The bounded turn policy is 20,000 cumulative tokens, 10 model steps, 10 tool calls and a 45-second deadline; output remains capped at 2,048 per request. These bounds support compound requests while preserving durable lease and journal fences.

## What was wrong

Old conversation was already omitted or summarized, but the entire active user turn's assistant/tool transcript remained mandatory. A successful batch of several operations therefore filled the next request. Optional personalization also originally aborted preparation before fallback, and new-resource schemas loaded unrelated historical references; those two defects were fixed in the preceding continuation work unit.

Live tests exposed another protocol defect: multiple `tools_select` calls were acknowledged as loaded but only the last schema was retained. Groq rejected subsequent calls to absent tools, sometimes returning a generated error without verified usage. Generic errors and unknown inference spend do not authorize replay. The existing narrow whole-decision unadvertised-tool rejection permits at most one schema refresh and a fresh model decision, never execution of rejected arguments; raising the budget does not make other errors safe to replay.

The loop now retains a batch of selected schemas, exposes only unloaded names through discovery, and warms task/reminder creation schemas under existing authenticated capabilities. Explicit selection now replaces the initial scope; recent successful schemas are cached from the owned interaction without classifying user phrases. See `v2-read-context-recovery.md` for the incident correction. Backend input validation, observed-ID checks, durable write authorization and attachment write caps remain enforced. The persona is shorter and explicitly asks for independent atomic actions, avoiding unnecessary rediscovery and preflight reads.

## What compaction sends

During and after active reads, the runner first tries the latest turn with a host-owned operational summary; other requests first try bounded historical context. Fresh reads omit historical resource arrays. If those do not fit, it may replace completed successful batches in the active turn with a host-derived summary of operation names and observed owned resource IDs/titles/times. The original user message stays exact. Unfinished, failed, partial, approval/clarification or indeterminate batches are not folded. All original messages, receipts and resources remain durable; projected summaries explicitly grant no authorization.

This avoids resending full arguments and results for work already completed. It does not summarize arbitrary user commands or invent a continuation plan. Extremely long current requests can still exhaust the policy even with no old history; bounded refusal now completes without poisoning the user's next turn.

Relative reminders additionally support `delayMinutes`. The tool boundary computes the ISO instant from `referenceTimeIso`; persistence continues receiving its existing certified ISO contract. Relative and absolute clocks are mutually exclusive and invalid values fail before dispatch. This removes arithmetic from the model for relative-minute requests. Explicit `today`/`tomorrow` plus AM/PM can instead use `relativeDayTime` with a 24-hour clock; the host preserves that local day without the half-day inference used for genuinely bare `unqualifiedLocalTime` inputs. Shared full/executable guidance separates independent clear actions from missing fields and scoped short answers. See [mixed temporal semantics](v2-mixed-temporal-semantics.md) for the exact contract and offline-proof boundary.

## Executable selection and safe diagnostics

If full context does not fit, compact mode may use an executable projection before folding completed tool batches: retain the current user message, active tool-call/result pairs, the bounded preceding dialogue, and the host-owned ordinal map, while omitting duplicate historical record arrays. A shorter instruction profile preserves the execution/safety rules. Full owned records and receipts remain durable; missing fields or resources require a read, not guessing. Explicit schema selection still replaces warm creation schemas. This does not increase any budget or guarantee every request fits.

The offline continuation regression uses nine known reminders, five ordinal references and a previous clarification. It checks both select → cancel and select → read → cancel, all four requested target IDs, every native-wire estimate <=2,500, and unchanged authorization/journal/reference guards. Scripted responses prove orchestration, not live interpretation.

`loop_limit` telemetry correlates run/request IDs with one bounded reason: `input_context`, `total_tokens`, `model_steps`, `tool_calls`, `history_messages`, `time`, or `cost`. Public `limit_reached` notices remain unchanged. The callback is observational: throwing cannot alter dispatch or accounting.

Each `provider_attempt` may carry a safe `failureClass`:

| Category | Observed evidence |
| --- | --- |
| `unadvertised_tool_rejection` | Existing narrowly recognized native-tool rejection; the loop still checks authorized catalogue membership and one-shot recovery. |
| `provider_error` | Error envelope or unsuccessful HTTP response; not proof of an outage or permission to retry. |
| `missing_usage` | Response lacks verified usage; accounting remains incomplete. |
| `invalid_response` | Local response validation failed with usage available. |
| `transport_uncertainty` | Transport/body acquisition did not complete; no inference replay or zero-spend claim. |
| `authentication` | HTTP401/403. |
| `rate_limit` | Existing explicit pre-generation HTTP429 rejection; only its established no-generation conditions allow zero usage. |

Healthy attempts omit `failureClass`. Categories contain no raw vendor messages, rejected arguments or user text. An explicit error envelope takes precedence over missing usage. Reporting occurs once after local validation and also on error exits; callbacks remain detached and exception-isolated. These categories do not broaden route fallback, schema recovery, user-visible notice enums or uncertain-effect replay.

### Guidance follows the current scope

Both full and executable context profiles derive control-tool instructions from the tools advertised for that decision. Before verified results make the clarification channel eligible, guidance keeps missing input pending and marks preceding operations `continue` without naming `conversation_clarify`. Once advertised, that channel receives its standalone, empty-content instruction. Selector instructions likewise require an advertised `tools_select`; an unloaded agenda schema is selected rather than called directly. This changes model guidance, not tool eligibility, authorization or the initial schema scope.

### Rejection and recovery evidence

Provider attempts additionally retain `advertisedToolNames` from the request payload: ordered identifier-only snapshots, limited to 64 names. `advertisedToolsTruncated` marks filtering or truncation. Only the existing narrow unadvertised-tool classifier adds `rejectedToolName`; healthy responses, generic errors and malformed rejection text do not fabricate one. Existing `providerErrorCode` and accounting fields remain available. These fields contain no descriptions, schemas, arguments, messages or credentials.

The optional `onToolSelection` observer emits a `tool_selection` event in the production host, correlated with run/request IDs. It includes the sanitized rejected name (or null for an invalid identifier), advertised names, truncation flag, accounting completeness and a decision/reason pair:

- `reload_schema` / `authorized_schema`: the existing predicate permits loading an authorized missing domain schema for a fresh decision.
- `stop`: `discovery_disabled`, `recovery_exhausted`, `reserved_control`, `unknown_tool`, `already_advertised`, or `turn_inactive`.

A reload decision records eligibility, **not proof that another HTTP request occurred**. Subsequent model-step/token/cost limits or the evaluator's unknown-spend lock can still prevent dispatch. Provider attempt telemetry describes the attempted payload; HTTP dispatch counts remain the budget transport's evidence. Observers receive detached, bounded data, and synchronous observer failures cannot change recovery, tool execution or accounting. No rejected arguments are executed and no inference is assumed free.

These additions cannot recover the lost rejected-tool name or missing billing from an older report. They apply to subsequent attempts; live interpretation still needs a separately authorized evaluation.

## Reference review

- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md) checks projected context after tool results, before the next response, and reserves response capacity. Its recent-token budgets are much larger than Hermes's application policy; the scheduling principle transfers, not the literal defaults.
- [OpenCode compaction](https://dev.opencode.ai/v2/docs/compaction/) separates a summary from recent work, runs at safe points, keeps storage history and warns that fixed instructions/tool schemas can dominate a request. We preserve the durable transcript and reduce the model projection at completed tool boundaries.
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction) carries prior state into a compacted Responses window. Its opaque encrypted items are provider-specific, so Hermes does not send them to Groq/OpenRouter. Hermes's summary remains a model-independent host structure.

## Evaluation and limitations

`pnpm run eval:context-budgets` now includes the original seven fixtures and nineteen compound/read/stress fixtures, each at 1,800 and 2,500. Positive cases include eight batched reminders, six sequential reminders, mixed recurring reminders/tasks, long history, large tool arguments and sources through 4,000 characters. Sources of 5,000/6,000 characters and a one-step fence are reported honestly as boundary/negative cases; no blanket promise that every request fits is made.

`pnpm exec tsx scripts/evals/v2-complex-budget.ts --live --output=<path>` runs five paired cases through the configured provider and isolated in-memory ports. Grading checks write counts, recurrence counts, relative/local timestamps and project grouping where relevant. It makes paid inference calls but no production writes or WhatsApp sends. This is one paired run per fixture, not a statistical semantic benchmark; project grouping is simulated, not certification of standalone project-management parity.

Evidence: `odd/evidence/agent-core-phase5/v2-2500-complex-release.json`. Earlier failed live passes informed the protocol fixes; they were not relabeled as successful tests. Main deployment must be certified by GitHub CI, Railway SUCCESS on the exact commit and `/health` after rollout.

Verified batch completion now uses a typed `turnDisposition` envelope, removing the prior regex selector and optionalizing final narration only after host verification. See [completion contract](v2-verified-completion.md).
