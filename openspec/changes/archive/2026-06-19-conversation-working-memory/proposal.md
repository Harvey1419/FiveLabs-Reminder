# Proposal: Conversation Working Memory (Level 1)

## Why

The bot treats every WhatsApp message as atomic and stateless — it forgets everything between turns. The user wants it to feel like a personal assistant that **remembers context within a conversation** and behaves coherently across multiple exchanges. This is **Level 1** of a 3-level memory strategy: working memory of the current conversation. Levels 2 (user profile / facts) and 3 (semantic recall) are deferred.

## What Changes

- [NEW] `src/db/schema.sql` — add `messages` table (id, phone_number, role 'user'|'assistant', content, intent, entities JSONB, created_at) + index on `(phone_number, created_at DESC)`.
- [NEW] `src/db/messages.js` — `saveMessage({ phoneNumber, role, content, intent, entities })` and `getRecentMessages(phone, limit=20)`. Supabase JS SDK v2 only, no raw SQL.
- [NEW] `src/ai/contextBuilder.js` — `buildMessages(phone, newUserText)`: returns MiniMax `messages` array `[system, ...history, newUser]`. History = last 20 rows for that phone, oldest → newest, role mapped to `user`/`assistant`.
- [MODIFIED] `src/ai/router.js` — accept `history` parameter, pass it to the chat completion call. Keep `response_format: { type: 'json_object' }` and intent/entity extraction logic intact.
- [MODIFIED] `src/webhook.js` — (a) `saveMessage(role='user')` before routing, (b) call `routeMessage` with the new history-aware signature, (c) `saveMessage(role='assistant')` after routing with the confirmation text and detected intent/entities.

## Impact

| Area | Status |
|------|--------|
| `src/ai/router.js` | MODIFIED (signature only, return shape unchanged) |
| `src/webhook.js` | MODIFIED (two new save calls + history arg) |
| `src/db/schema.sql` | MODIFIED (additive: new table + index) |
| `src/db/messages.js` | NEW |
| `src/ai/contextBuilder.js` | NEW |
| `src/scheduler.js`, `calculateSendAt`, `sendReminderMessage`, `reminders` table, Kapso send | **NOT AFFECTED** — reminder flow untouched. `routeMessage` still returns `{intent, entities, response}`; `saveReminder` is still called with the same args when intent is `create_reminder`. |
| `src/handlers/*` | **NOT AFFECTED** — dead code, explicitly out of scope. |
| `package.json` | **NOT AFFECTED** — no new dependencies. |

## Non-Goals

- Level 2: user profile, `user_facts`, preferences, name, timezone.
- Level 3: pgvector / semantic recall across old conversations.
- Proactive nudges (bot initiating a message without user input).
- Onboarding interview.
- Webhook signature verification, RLS policies, migration of scheduler to pg_cron.

## Capabilities

> Contract for sdd-spec.

### New Capabilities
- `conversation-memory`: persist and retrieve per-phone conversation history; assemble MiniMax message arrays with bounded history for context-aware routing.

### Modified Capabilities
- None — `openspec/specs/` is empty; no existing spec-level requirements change.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Webhook latency grows by one extra DB write per turn | Low | Assistant save is fire-and-forget; user save can run in parallel with history fetch. |
| History fetch blocks routing on slow DB | Low | Single indexed query; on failure, fall back to stateless (current behavior) so reminders still work. |
| Reminder regression from `routeMessage` signature change | Low | Return shape `{intent, entities, response}` is preserved; `saveReminder` call site unchanged. Verify with a real "recuérdame en 1 minuto…" message before merge. |

## Rollback Plan

1. Revert `src/webhook.js`, `src/ai/router.js`, `src/ai/contextBuilder.js`, `src/db/messages.js`, and the new portion of `src/db/schema.sql`.
2. `DROP TABLE IF EXISTS messages;` — no FK, no dependency from `reminders`.
3. Re-deploy. The reminder flow is fully decoupled from conversation history, so rollback is safe even mid-scheduler-loop.

## Acceptance Criteria

User-verifiable via WhatsApp:

- [ ] Send "hola" → bot replies. Send "y mi nombre?" → bot does **not** know the name yet (Level 1 only; Level 2 will fix this).
- [ ] Send "¿qué día es hoy?" then "y mañana?" → second response correctly references the prior turn's date.
- [ ] Send "recuérdame en 1 minuto que debo sacar la basura" → a `reminders` row is created with correct `send_at`, the confirmation text mentions "sacar la basura", and the message arrives ~1 minute later via Kapso.
- [ ] Send "recuerda en 10 días llamar a mamá" → `reminders.send_at` ≈ now+10d, message arrives at that exact time.
- [ ] After any exchange, the `messages` table contains two new rows for that phone (one `user`, one `assistant`) with the detected `intent` and `entities`.
- [ ] Send 25 messages in a row → only the last 20 are included in the next MiniMax request (history is bounded).
