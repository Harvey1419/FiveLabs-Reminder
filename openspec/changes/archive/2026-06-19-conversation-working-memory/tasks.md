# Tasks: Conversation Working Memory (Level 1)

## 1. Add `messages` table DDL + index

- [x] 1.1 Append `messages` (id UUID PK, `phone_number`, `role` CHECK `'user'|'assistant'`, `content`, `intent`, `entities` JSONB, `created_at` default `NOW()`) + index `(phone_number, created_at DESC)` to `src/db/schema.sql` with `IF NOT EXISTS`.
- [ ] 1.2 Run the appended DDL in Supabase SQL editor (manual, README §3); confirm `messages` + `idx_messages_phone_created` exist.

## 2. Create `src/db/messages.js`

- [x] 2.1 Export `saveMessage({ phoneNumber, role, content, intent, entities })` — Supabase JS v2 insert, never `throw`, log + return falsy on error.
- [x] 2.2 Export `getRecentMessages(phone, limit = 20)` — clamp `limit` to `[1, 100]`, select `role, content, created_at`, filter by `phone_number`, order `created_at DESC`, reverse to ASC, strip DB-only fields, return `[]` on error (stateless fallback).

## 3. Create `src/ai/contextBuilder.js`

- [x] 3.1 Export `buildContext(phone, newMessageText)` — fetch via `getRecentMessages(phone, 20)`, return `[system, ...history, newUser]` using `SYSTEM_PROMPT` (moved here, re-imported by `router.js`).

## 4. Modify `src/ai/router.js` signature only

- [x] 4.1 Import `SYSTEM_PROMPT` from `./contextBuilder.js`; remove local constant.
- [x] 4.2 New signature `routeMessage(messageText, phoneNumber, history = [])`; build `messages: [system, ...history, { role: 'user', content: messageText }]`.
- [x] 4.3 Keep `response_format: { type: 'json_object' }`, `try/JSON.parse` fallback, and the `if (result.intent === 'reminder') saveReminder(...)` block unchanged. Return shape stays `{ intent, entities, language, confirmation }` — do **not** rename to `response` (webhook reads `confirmation`; renaming would break the reminder path).

## 5. Modify `src/webhook.js`

- [x] 5.1 Before routing: `await saveMessage({ phoneNumber, role: 'user', content: messageText }).catch(err => console.error('saveMessage(user) failed:', err))`.
- [x] 5.2 `const history = await getRecentMessages(phoneNumber, 20)` (already non-throwing) and pass as third arg to `routeMessage`.
- [x] 5.3 After confirmation send, `await saveMessage({ phoneNumber, role: 'assistant', content: result.confirmation ?? '', intent: result.intent, entities: result.entities ?? {} }).catch(...)` (best-effort). Outer 500-handler `try/catch` untouched.

## 6. Manual verification (WhatsApp + Supabase)

- [ ] 6.1 "hola" + "y mi nombre?" — bot replies, 2 new `messages` rows (1 `user`, 1 `assistant`), bot does **not** know the name (Level 1 only).
- [ ] 6.2 "¿qué día es hoy?" then "y mañana?" — second reply references the prior turn's date.
- [ ] 6.3 "recuérdame en 1 minuto que debo sacar la basura" — `reminders.send_at ≈ now+60s`, confirmation mentions the content, Kapso delivers ~60s later.
- [ ] 6.4 "recuerda en 10 días llamar a mamá" — `reminders.send_at ≈ now+10d`, delivered on time.
- [ ] 6.5 Send 25 messages in a row — only the last 20 rows ship on the next MiniMax call (history bounded).

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Total estimated changed lines | ~95 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Delivery strategy | single-pr |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

Reasoning: ~95 lines across 5 files (1 new table + 1 new DB module + 1 new context builder + 2 signature/wiring edits). All additive or signature-only; reminder flow frozen. Well under 400-line budget — one work-unit commit, single PR, no chained slice needed.
