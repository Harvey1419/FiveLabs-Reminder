# Tasks: Foundation, User Model, and Resilient Scheduler (Phase 1)

## 1. Database Schema & Users Data Access

- [x] 1.1 Update `src/db/schema.sql` to define `users` table (`id` UUID PK, `phone_number` UNIQUE, `display_name`, `timezone`, `locale`, `created_at`, `updated_at`) and add `user_id` column to `messages` and `reminders`.
- [x] 1.2 Create `src/db/users.js` with `getOrCreateUserByPhone(phoneNumber)` and `updateUserPreferences(userId, data)`.
- [x] 1.3 Update `src/db/index.js` to support `userId` in `saveReminder` and export users module.
- [x] 1.4 Update `src/db/messages.js` to support optional `userId` on insert.

## 2. Pure Time & Timezone Module

- [x] 2.1 Create `src/utils/time.js` implementing `computeOffsetMinutes(tz)`, `nowISO(tz)`, `nowHuman(tz, lang)`, `parseTargetTime(str, tz)`, `humanizeTimeUntil(date, lang)`, and `formatLocalDateTime(date, tz)`.

## 3. Clean Dead & Conflicting Code

- [x] 3.1 Delete `src/handlers/index.js` and `src/handlers/reminderHandler.js`.
- [x] 3.2 Delete `src/ai/contextBuilder.js`.

## 4. Refactor AI Router & Webhook Orchestrator

- [x] 4.1 Refactor `src/ai/router.js` to import time functions from `src/utils/time.js` and accept `user` object for timezone-anchored prompts.
- [x] 4.2 Refactor `src/webhook.js` to resolve `user` via `getOrCreateUserByPhone(phoneNumber)`, pass `user` into `routeMessage`, and persist `user_id`.

## 5. Refactor Scheduler & Verification

- [x] 5.1 Update `src/scheduler.js` to format reminder times using recipient's timezone.
- [x] 5.2 Verify with node smoke check: `node --check src/index.js` and execute end-to-end routing test script.
