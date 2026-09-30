# State-authority baseline — 2026-09-30 UTC

Production source inspected: `6624808a223c1b471c00933d4d8f88169541d101`.
Synthetic full-router evaluation: commit `a0819fa865c9e11f9c89b3a4e74e5aa9c7b0d318`, workflow run `36660766041`, job `109714785993`.

## What actually ran

The real foreground provider client called `openai/gpt-oss-120b` via Groq in all nine cases. Model responses were NOT mocked. Database reads were synthetic, only the task read tool was executable, and network access outside the model endpoint was blocked. No WhatsApp messages or production writes were made. Nine model requests were observed.

This is a baseline, NOT a completed production fix and NOT an exhaustive quality score.

## Observations

| Scenario | Observed result | Acceptance |
| --- | --- | --- |
| Clean history | Correct synthetic 720,000, but conversation.reply and no execution evidence | Failed |
| Stale memory | Correct synthetic 720,000, but conversation.reply and no execution evidence | Failed |
| Audio transcription with stale history | Correct synthetic 720,000, but conversation.reply and no execution evidence | Failed |
| Stale memory plus history | Incorrect synthetic 190,000 remainder, no execution evidence | Failed |
| Implicit project reference | Incorrect synthetic 190,000 remainder, no execution evidence | Failed |
| Task source unavailable | Selected reminder.list instead of the task source; fixture rejected the wrong domain | Failed |
| Empty current task source | Repeated the historical 720,000 as pending without a task read | Failed |
| Ordinary conversation | Natural chat, no domain calls | Passed |
| Durable communication preference | Natural preference recall, no domain calls | Passed |

Seven operational scenarios failed the evidence acceptance criteria; the two conversation controls passed. The clean-history cases illustrate why a correct-looking number alone is not enough. An overview preload is not equivalent to a response explicitly bound to its verified records. The wrong-domain read in the unavailable-source case was **not** a mutation attempt.

## Next implementation boundary

1. Keep one canonical query path and remove instructions that exempt stateful conversation.reply from it.
2. Represent concise read answers as typed selections/projections over current read results; never accept literal model-supplied balances as those results.
3. Preserve status, ownership, freshness and completeness. A pending return is not a completed payment; an empty source is not automatically a zero balance.
4. Keep original mutation/approval behavior and durable personal-memory conversation.
5. Run the same real-provider/router cases after changes, plus deterministic source-binding and presentation tests. Do not substitute prompt-string assertions or an observe-only success for semantic acceptance.

RLS, Railway configuration, billing and production data changes are outside this delivery.
