# Fresh reads and historical request isolation

The production turn `b2487334-df20-47b1-aaa2-b8cfbc05bfd7` asked for today's reminders, selected `reminder_read`, and ended with `limit_reached` before any domain dispatch. Railway reported a 2,473-token initial estimate against the 2,500-token policy. Its accepted WhatsApp reply incorrectly referred to confirmed results despite an empty item list.

The failure was not a provider context-window overflow. Host preparation combined unrelated warmed creation schemas, historical reminder references, and previous operations with the newly selected read schema. A separate isolated replay exposed historical request replay: retaining old authored commands merely because they fit encouraged the model to resume an old creation request after the read.

The correction has four parts:

- Explicit tool selection replaces the warmed schema scope; independent schemas selected together remain loaded. Discovery cannot authorize same-batch execution of an unadvertised function.
- A bounded ES/EN authored-text hint prefetches read schemas for common listing requests. This changes availability only, never executes a tool or grants permissions. Unknown and mixed requests retain normal discovery.
- Reads do not inject historical resource arrays. During and after an active read, context preparation prefers the most recent valid turn boundary plus the existing host-owned operational summary. Pending, partial and indeterminate operations remain in that summary; owned mutation references, full transcripts and receipts remain durable. The persona explicitly forbids treating old requests as queued work.
- An empty result with a loop notice no longer claims that results appear above it.

This is a targeted prerequisite to the broader compaction plan. A persistent conversational summary, retrieval of earlier dialogue, source-grounded mutation authorization and provider-native compaction remain separate work. Summarization is lossy and cannot guarantee arbitrary requests fit a fixed budget. Provider failures also remain possible.

Verification includes audio admission with a historical ledger, selection scope, read/cancel continuation, unresolved-effect preservation, bilingual no-result presentation, offline capacity cases and a real-provider replay using the incident's 73-message checkpoint with isolated ports. The replay grades exactly one `today` read and zero writes; it does not query live reminder inventory or send WhatsApp. Intermediate replay failures are retained locally and are not counted as successful certifications. Snapshot contents are never committed.

Reproduce offline with `pnpm run eval:context-budgets`. For a bounded paid isolated read evaluation use `pnpm exec tsx scripts/evals/v2-complex-budget.ts --live --case=read_today_long_history --output=/private/tmp/read-eval.json`. An explicitly obtained private checkpoint can be supplied with `--snapshot=/private/tmp/checkpoint.json`; this option is restricted to the read case. The 2,500-token gate and full transcript validation remain enforced.

Roll back the release commit to restore the previous schema loading, read projection and presentation together. Deploy only through GitHub; Railway CLI deployment is not part of this workflow.
