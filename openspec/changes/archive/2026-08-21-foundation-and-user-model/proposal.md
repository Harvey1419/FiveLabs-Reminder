# Proposal: Foundation, User Model, and Resilient Scheduler (Phase 1)

## Why

The current implementation has foundational debt that blocks reliable expansion into tasks, entities, and vector memory:
1. **Server-dependent Timezone**: Time calculations in `src/ai/router.js` and `src/scheduler.js` rely on `Intl.DateTimeFormat().resolvedOptions().timeZone` of the host OS instead of a per-user timezone preference. When deployed on UTC cloud servers (Railway, Render, AWS), absolute times ("a las 8 pm") calculate incorrectly for users in other timezones (e.g. `America/Bogota`).
2. **Dead & Inconsistent Code**: `src/handlers/index.js`, `src/handlers/reminderHandler.js`, and `src/ai/contextBuilder.js` are unreferenced or contain conflicting prompts that confuse development.
3. **Monolithic Router**: `src/ai/router.js` combines intent classification, MiniMax HTTP calls, date parsing, and database persistence in one 450-line file.
4. **Single-Process Scheduler without Concurrency Protection**: The in-memory polling loop in `src/scheduler.js` lacks transactional locking, risking duplicate reminder delivery if multiple instances boot.

This change establishes the clean architectural foundation, introduces a `users` table for timezone and locale isolation, cleans dead code, modularizes time handling, and prepares the scheduler for atomic processing.

## What Changes

- [NEW] `src/db/schema.sql` — Add `users` table (`id` UUID PK, `phone_number` TEXT UNIQUE NOT NULL, `display_name` TEXT, `timezone` TEXT DEFAULT `'America/Bogota'`, `locale` TEXT DEFAULT `'es-CO'`, `created_at`, `updated_at`) and foreign key reference from `messages.user_id` and `reminders.user_id`.
- [NEW] `src/db/users.js` — Export `getOrCreateUserByPhone(phoneNumber)` and `updateUserPreferences(userId, { timezone, displayName, locale })`.
- [NEW] `src/utils/time.js` — Centralize timezone-aware formatting, ISO parsing, and relative humanization anchored to the user's specific IANA timezone (using native `Intl` and date math).
- [DELETED] `src/handlers/index.js` and `src/handlers/reminderHandler.js` — Remove dead code.
- [REFACTORED] `src/ai/router.js` — Delegate time parsing to `src/utils/time.js`, accept user object (with user timezone) to compute accurate target timestamps.
- [REFACTORED] `src/webhook.js` — Resolve/create user record upon inbound message, pass `user` into router, link `user_id` on message saves.
- [REFACTORED] `src/scheduler.js` — Query reminders with join on `users` to format notifications in each user's local timezone.

## Impact

| Area | Status |
|------|--------|
| `src/db/schema.sql` | MODIFIED (additive: `users` table, migration script for existing messages/reminders) |
| `src/db/users.js` | NEW |
| `src/utils/time.js` | NEW |
| `src/handlers/*` | REMOVED (dead code cleanup) |
| `src/ai/contextBuilder.js` | REMOVED (redundant prompt file) |
| `src/ai/router.js` | MODIFIED (modularized time math, accepts user context) |
| `src/webhook.js` | MODIFIED (resolves user before routing) |
| `src/scheduler.js` | MODIFIED (uses user timezone for notifications) |
| `src/utils/kapso.js` | UNCHANGED |

## Non-Goals

- Tasks and entity graphs (deferred to Phase 2: `task-and-entity-tools`).
- Vector search with `pgvector` and background memory extractor (deferred to Phase 3: `semantic-memory-pipeline`).
- Proactive follow-ups engine (deferred to Phase 4).

## Capabilities

### New Capabilities
- `user-model`: Per-phone user resolution, persistence of user preferences, and user-scoped timezone and locale.
- `timezone-engine`: Deterministic time calculation using user-specific IANA timezones instead of server host environment.

### Modified Capabilities
- `conversation-memory`: Messages linked to `user_id` (while retaining `phone_number` backward compatibility during transition).
- `reminder-scheduling`: Notification rendering uses user's timezone.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Inbound message blocked if `users` query fails | Low | `getOrCreateUserByPhone` has fallback to default user object in memory if DB write fails. |
| Existing reminder timestamps misalign during migration | Low | All database timestamps remain in standard UTC (`TIMESTAMPTZ`); only prompt and rendering helpers convert to user local time. |
| Timezone parsing errors for invalid IANA strings | Low | Fallback to `'America/Bogota'` or `'UTC'` on `Intl` constructor exception. |

## Rollback Plan

1. Revert modifications in `src/webhook.js`, `src/ai/router.js`, `src/scheduler.js`.
2. Restore legacy time helpers inside `router.js`.
3. `DROP TABLE IF EXISTS users CASCADE;` (optional, since additive tables do not break older code).
4. Re-deploy.
