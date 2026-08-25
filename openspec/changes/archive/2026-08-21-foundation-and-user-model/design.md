# Design: Foundation, User Model, and Resilient Scheduler (Phase 1)

## Context

The current WhatsApp reminder assistant operates with server-local timezone assumptions and inline time parsing embedded in `src/ai/router.js`. To evolve into a stateful assistant, we need:
1. Multi-tenant user isolation starting from the database (`users` table).
2. Clean separation of pure time math into `src/utils/time.js`.
3. Removal of dead code files (`src/handlers/index.js`, `src/handlers/reminderHandler.js`, `src/ai/contextBuilder.js`).
4. Safe backward-compatible schema migration.

## Architectural Decisions

### Decision 1: Per-User Timezone Resolution
- **Problem**: Host server timezone varies (e.g. UTC on Railway, EST on Mac). Users in Colombia (`America/Bogota`) expecting reminders for "10:00 pm" get parsed relative to UTC if host is UTC.
- **Solution**: Store `timezone` in `users` (default `'America/Bogota'`). Pass user's timezone into `nowISO(tz)`, `nowHuman(tz, locale)`, and `parseTargetTime(str, tz)`.
- **Alternatives Considered**: Ingesting timezone from WhatsApp metadata — WhatsApp Business Webhooks do not supply user timezone in payload; it must be stored in user profile.

### Decision 2: Pure Time Module (`src/utils/time.js`)
- **Structure**:
  - `computeOffsetMinutes(timezone)`
  - `nowISO(timezone)`
  - `nowHuman(timezone, locale)`
  - `parseTargetTime(targetTimeStr, timezone)`
  - `humanizeTimeUntil(targetDate, language)`
  - `formatLocalDateTime(date, timezone, locale)`
- **Behavior**: Uses standard Node.js `Intl.DateTimeFormat` with IANA timezone strings, preventing external dependency bloat.

### Decision 3: Database Schema Migration Strategy
- `users` table created with `IF NOT EXISTS`.
- `messages` and `reminders` tables gain optional `user_id UUID REFERENCES users(id)` column (retaining `phone_number` for full backward compatibility).
- Inbound webhook guarantees a `users` row exists for `phone_number` before message routing.

## Sequence Flow

```text
WhatsApp Inbound Message
        │
        ▼
[src/webhook.js]
  ├── isDuplicate(messageId)
  ├── sendTypingIndicator(messageId)
  ├── getOrCreateUserByPhone(phone) ───► Supabase `users`
  ├── saveMessage({ user, role: 'user', content })
  ├── getRecentMessages(phone, 20)
  ├── routeMessage(messageText, user, history) ───► [src/ai/router.js]
  │     ├── time helpers from [src/utils/time.js] using user.timezone
  │     ├── classifyAndExtract()
  │     ├── if reminder ───► saveReminder({ userId, phone, content, sendAt })
  │     └── if chat ───► generateContextualReply()
  ├── sendReminderConfirmation()
  └── saveMessage({ user, role: 'assistant', content, intent, entities })
```

## Review Workload Forecast

| Metric | Target |
|--------|--------|
| Changed files | 8 |
| Estimated line diff | ~250 lines |
| 400-line budget risk | Low |
| Single PR delivery | Yes |
