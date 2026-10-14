# V2 compound requests with a 2,500-token input budget

V2 now uses 2,500 estimated input tokens per model request. This is a cost/context policy, not the model's native context window or the whole-turn total. The bounded turn policy is 20,000 cumulative tokens, 10 model steps, 10 tool calls and a 45-second deadline; output remains capped at 768 per request. These bounds support compound requests while preserving durable lease and journal fences.

## What was wrong

Old conversation was already omitted or summarized, but the entire active user turn's assistant/tool transcript remained mandatory. A successful batch of several operations therefore filled the next request. Optional personalization also originally aborted preparation before fallback, and new-resource schemas loaded unrelated historical references; those two defects were fixed in the preceding continuation work unit.

Live tests exposed another protocol defect: multiple `tools_select` calls were acknowledged as loaded but only the last schema was retained. Groq rejected subsequent calls to absent tools, sometimes returning a generated error without verified usage. Such errors remain non-retryable; raising the budget does not make those errors safe to replay.

The loop now retains a batch of selected schemas, exposes only unloaded names through discovery, and warms task/reminder creation schemas under existing authenticated capabilities. Those two common schemas remain available when another operation is loaded. Backend input validation, observed-ID checks, durable write authorization and attachment write caps remain enforced. The persona is shorter and explicitly asks for independent atomic actions, avoiding unnecessary rediscovery and preflight reads.

## What compaction sends

The runner first tries its existing bounded historical context, optional personal context and current paired tool transcript. If those do not fit, it may replace completed successful batches in the active turn with a host-derived summary of operation names and observed owned resource IDs/titles/times. The original user message stays exact. Unfinished, failed, partial, approval/clarification or indeterminate batches are not folded. All original messages, receipts and resources remain durable; projected summaries explicitly grant no authorization.

This avoids resending full arguments and results for work already completed. It does not summarize arbitrary user commands or invent a continuation plan. Extremely long current requests can still exhaust the policy even with no old history; bounded refusal now completes without poisoning the user's next turn.

Relative reminders additionally support `delayMinutes`. The tool boundary computes the ISO instant from `referenceTimeIso`; persistence continues receiving its existing certified ISO contract. Relative and absolute clocks are mutually exclusive and invalid values fail before dispatch. This removes arithmetic from the model for relative-minute requests.

## Reference review

- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md) checks projected context after tool results, before the next response, and reserves response capacity. Its recent-token budgets are much larger than Hermes's application policy; the scheduling principle transfers, not the literal defaults.
- [OpenCode compaction](https://dev.opencode.ai/v2/docs/compaction/) separates a summary from recent work, runs at safe points, keeps storage history and warns that fixed instructions/tool schemas can dominate a request. We preserve the durable transcript and reduce the model projection at completed tool boundaries.
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction) carries prior state into a compacted Responses window. Its opaque encrypted items are provider-specific, so Hermes does not send them to Groq/OpenRouter. Hermes's summary remains a model-independent host structure.

## Evaluation and limitations

`pnpm run eval:context-budgets` now includes the original seven fixtures and eighteen compound/stress fixtures, each at 1,800 and 2,500. Positive cases include eight batched reminders, six sequential reminders, mixed recurring reminders/tasks, long history, large tool arguments and sources through 4,000 characters. Sources of 5,000/6,000 characters and a one-step fence are reported honestly as boundary/negative cases; no blanket promise that every request fits is made.

`pnpm exec tsx scripts/evals/v2-complex-budget.ts --live --output=<path>` runs four paired cases through the configured provider and isolated in-memory ports. Grading checks write counts, recurrence counts, relative/local timestamps and project grouping where relevant. It makes paid inference calls but no production writes or WhatsApp sends. This is one paired run per fixture, not a statistical semantic benchmark; project grouping is simulated, not certification of standalone project-management parity.

Evidence: `odd/evidence/agent-core-phase5/v2-2500-complex-release.json`. Earlier failed live passes informed the protocol fixes; they were not relabeled as successful tests. Main deployment must be certified by GitHub CI, Railway SUCCESS on the exact commit and `/health` after rollout.
