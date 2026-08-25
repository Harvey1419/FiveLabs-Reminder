# Design: Conversation Working Memory (Level 1)

## Goal

Persist every WhatsApp turn to a new `messages` table and inject the most recent 20 turns per phone into MiniMax calls so the assistant replies with awareness of prior turns — without changing the reminder flow.

## Architecture overview

```
Kapso webhook
     │
     ▼
handleWebhook (src/webhook.js)
     │
     ├──► saveMessage(role='user')     ◄── best-effort, try/catch
     ├──► buildContext(phone, text)    ◄── src/ai/contextBuilder.js (NEW)
     │       │
     │       └──► getRecentMessages(phone, 20)   ◄── src/db/messages.js (NEW)
     │              │  on error → return []
     │              ▼
     │         [system, ...history, newUser]
     │
     ├──► routeMessage(text, phone, history)  ◄── src/ai/router.js (MODIFIED)
     │       │
     │       ├──► MiniMax chatcompletion_pro  (response_format: json_object)
     │       └──► saveReminder(...)           ◄── only when intent=reminder
     │
     ├──► sendReminderConfirmation(phone, text)  ◄── if result.confirmation
     └──► saveMessage(role='assistant', intent, entities)  ◄── best-effort
```

The reminder path (`calculateSendAt`, `saveReminder`, `scheduler.startScheduler`, `sendReminderMessage`) is **frozen** and reused as-is. `routeMessage` keeps its return shape `{intent, entities, language, confirmation}`; `webhook.js` keeps `result.confirmation` as the user-visible text.

## File-by-file plan

### `src/db/schema.sql` — MODIFIED (additive)

Append the `messages` table + index. Run manually in Supabase SQL editor per README §3.

```sql
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  intent TEXT,
  entities JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_phone_created
  ON messages(phone_number, created_at DESC);
```

Notes:
- `role` CHECK enforces the spec's "Data Integrity Constraints".
- Composite index `(phone_number, created_at DESC)` matches the only query shape (`WHERE phone_number = ? ORDER BY created_at DESC LIMIT N`).
- No FK to `reminders`; rollback is a single `DROP TABLE`.

### `src/db/messages.js` — NEW

- `saveMessage({ phoneNumber, role, content, intent, entities })`:
  - Supabase JS v2 insert into `messages`. **No `throw`** — log error and return `null`/`false` so the webhook never breaks on persistence failure.
  - `intent`/`entities` may be `undefined`; let Supabase persist `null`.
- `getRecentMessages(phone, limit = 20)`:
  - `limit = Math.min(Math.max(1, Number(limit) || 20), 100)`.
  - Query: `select('role, content, created_at').eq('phone_number', phone).order('created_at', { ascending: false }).limit(limit)`.
  - **Reverse the array in JS** so callers receive ASC (chat replay order, oldest → newest).
  - On error: `console.error` and return `[]` — this is the "stateless fallback" hook.
  - Returns `Array<{role, content}>` only — strip DB-only fields.

### `src/ai/contextBuilder.js` — NEW

Pure function, no I/O outside `getRecentMessages`:

- `buildContext(phone, newMessageText)`:
  - `const history = await getRecentMessages(phone, 20);` (never throws)
  - Returns `[ { role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: newMessageText } ]`.
- `SYSTEM_PROMPT` lives in this module and is exported so `router.js` imports it (single source of truth — `router.js` no longer owns the prompt string).
- Privacy boundary is enforced here: the `phone` argument is the only key passed to `getRecentMessages`, so the assembled array cannot leak another phone's turns.

### `src/ai/router.js` — MODIFIED (signature only)

- Import `SYSTEM_PROMPT` from `./contextBuilder.js`; remove the local constant.
- New signature: `export async function routeMessage(messageText, phoneNumber, history = [])`.
- Body: `messages: [system, ...history, { role: 'user', content: messageText }]`.
- Keep `response_format: { type: 'json_object' }` and the existing `try/JSON.parse` fallback.
- Keep the `if (result.intent === 'reminder') { saveReminder(...) }` block exactly as-is.
- Return shape unchanged: `{ intent, entities, language, confirmation }`.

### `src/webhook.js` — MODIFIED

- After extracting `phoneNumber`/`messageText` and **before** routing:
  - `await saveMessage({ phoneNumber, role: 'user', content: messageText }).catch(err => console.error('saveMessage(user) failed:', err));`
- `const history = await getRecentMessages(phoneNumber, 20);` — pass into `routeMessage`. No try/catch needed; `getRecentMessages` already swallows errors and returns `[]`.
- After `routeMessage` returns and the confirmation is sent (or skipped if absent):
  - `await saveMessage({ phoneNumber, role: 'assistant', content: result.confirmation ?? '', intent: result.intent, entities: result.entities ?? {} }).catch(err => console.error('saveMessage(assistant) failed:', err));`
- Outer `try/catch` (500 handler) stays unchanged.

## Data flow — MiniMax call shape

For phone `+5491133334444` with two prior turns and new message "y mañana?":

```json
{
  "model": "MiniMax-Text-01",
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "You are a helpful WhatsApp assistant…" },
    { "role": "user",      "content": "¿qué día es hoy?" },
    { "role": "assistant", "content": "Hoy es martes 17 de junio" },
    { "role": "user",      "content": "y mañana?" }
  ]
}
```

History ASC, new user last, system first — exactly what MiniMax expects for multi-turn chat.

## Resilience decisions

| Failure | Behavior | Why |
|---------|----------|-----|
| `saveMessage(user)` throws | Logged; routing continues | Spec: "MUST NOT break webhook delivery" |
| `getRecentMessages` throws or returns `[]` | `history = []`; routing continues | Spec: stateless fallback — reminder still works |
| `saveMessage(assistant)` throws | Logged; response already sent | User already saw the reply; persistence is best-effort |
| MiniMax returns non-JSON | Existing fallback returns `{intent: 'unknown', ...}` | Unchanged from current code |

## Migration

`src/db/schema.sql` is the only schema artifact. It is **appended** (idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`) and run manually in the Supabase SQL editor, matching the existing README §3 flow ("Go to Supabase SQL Editor and run `src/db/schema.sql`"). No migration tooling, no CLI, no rollback script beyond the proposal's documented `DROP TABLE IF EXISTS messages;`.

## What we are NOT changing

- `src/scheduler.js`, `calculateSendAt` (lives in `router.js`), `sendReminderMessage`, `reminders` table, `src/db/index.js` reminder helpers.
- `package.json` — no new dependencies (Supabase JS v2 already present).
- `src/handlers/*` — dead code, explicitly out of scope per proposal.
- RLS policies, webhook signature verification, pg_cron migration of the scheduler.
- The `confirmation` field in MiniMax's JSON contract and in `webhook.js`.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| History fetch adds latency on first call | Single indexed query on `(phone_number, created_at DESC)`; default limit 20; hard cap 100 inside `getRecentMessages`. |
| Assistant save throws after response sent | Outer try/catch in `webhook.js` already handles this; persistence is best-effort by contract. |
| Privacy leak across phones | `buildContext` is the only place that calls `getRecentMessages`; it threads `phone` as the filter, never a wider set. |
| Role CHECK blocks future roles | Documented in spec; extending roles (e.g., `system`) requires a new migration — out of scope. |
| Reminder regression from `routeMessage` signature change | Return shape unchanged; `saveReminder` call site unchanged; verified by acceptance test "recuérdame en 1 minuto…". |

## Estimated diff size

| File | Action | Lines (Δ) |
|------|--------|-----------|
| `src/db/schema.sql` | +12 | +12 |
| `src/db/messages.js` | NEW | ~40 |
| `src/ai/contextBuilder.js` | NEW | ~25 |
| `src/ai/router.js` | ~10 | ~10 |
| `src/webhook.js` | ~8 | ~8 |
| **Total** | | **~95 lines** |

Well under the 400-line review budget. One work-unit commit; `single-pr` is the right strategy.
