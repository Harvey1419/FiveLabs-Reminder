# Portable conversational compaction plan

## Required behavior

The latest authored WhatsApp message defines the active request. The immediately preceding interaction supplies referents, displayed ordinals, unresolved questions and explicit confirmations. Earlier dialogue supplies relevant background only; historical commands never become a work queue. Durable receipts and unresolved effects govern execution independently of model prose or summaries.

API-key versus subscription authentication does not determine compaction ownership. Hermes keeps a portable application-level implementation. Native compaction is an optional, explicitly verified provider/endpoint/model capability. The 2,500-token input policy is distinct from the model context window; compaction calls need separate usage accounting.

## Delivery sequence

1. **Incident prerequisites:** replace warmed schemas on explicit selection, prefetch bounded fresh-read schemas, omit unrelated historical reference arrays, prefer active reads over raw old commands, and render honest empty-result notices. Implemented in the read-context recovery work unit, with checkpoint replay and bounded tests.
2. **Explain context pressure:** measure instructions, schemas, current request, recent interaction, memories and observations before/after projection. Distinguish preparation limits, deadline/step limits and provider errors; preserve generation IDs and unknown usage.
3. **Persist portable continuity:** version summaries with source-message boundaries, goals, relevant dialogue, explicit corrections, unresolved questions and references to durable receipts. Validate summaries against host-owned state; personal memory admission remains separate. Preserve the latest interaction when needed to interpret the current message.
4. **Compact at safe boundaries:** reserve continuation space before each call; project large observations and load older details on demand. Keep original current text, complete tool pairs, pending approvals and uncertain effects. A summary cannot authorize writes or certify a database result.
5. **Recover and change providers safely:** permit only bounded overflow recovery with verified inference accounting and durable effect reconciliation. Provider-native checkpoints stay scoped to their supported integration; retain a portable summary for switching models. Do not blindly retry writes or discard uncertain outcomes.
6. **Certify functional equivalence:** compare the current release and new compactor on long conversations, old-command replay, pronouns/ordinals, corrections, pending confirmations, multiple actions, restarts and provider changes. Grade task completion, unintended writes, lost references, latency and total billed usage, including compaction. GitHub CI and staged Railway rollout must pass before expanding traffic.

The incident fix establishes prerequisites, not full Pi/OpenCode parity. A summary alone cannot repair overly broad tool scopes, ungrounded action selection or arbitrary provider failures. No claim of definitive elimination of all incomplete responses is justified by a single successful replay.

References: [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md), [OpenCode](https://dev.opencode.ai/v2/docs/compaction/), [OpenAI native compaction](https://developers.openai.com/api/docs/guides/compaction), [OpenRouter message transforms](https://openrouter.ai/docs/guides/features/message-transforms).
