# Tasks: Semantic and Persistent Memory Pipeline (Phase 3)

## 1. Database Schema & Migration

- [x] 1.1 Update `src/db/schema.sql` to define `memories` table with `topic_key`, `category`, `embedding`, `is_active`, `superseded_by`, indexes, and `match_memories` search function.
- [x] 1.2 Apply migration to Supabase live database via Supabase MCP `apply_migration`.

## 2. Data Access Layer

- [x] 2.1 Create `src/db/memories.js` implementing `saveMemory`, `searchMemories`, `supersedeMemory`, `getMemoriesByTopic`, and `forgetMemories`.
- [x] 2.2 Export memories module from `src/db/index.js`.

## 3. Memory Service & Background Extractor

- [x] 3.1 Create `src/services/memoryService.js` to handle extraction prompts, conflict detection, and memory upserts.
- [x] 3.2 Create `src/workers/memoryExtractor.js` for out-of-band asynchronous processing.

## 4. Webhook & Router Integration

- [x] 4.1 Update `src/webhook.js` to trigger `extractMemoryInBackground(user, userText, assistantReply)` without awaiting completion.
- [x] 4.2 Update `src/ai/router.js` to search relevant memories during contextual chat assembly.

## 5. Verification & Tests

- [x] 5.1 Run automated end-to-end memory test verifying fact extraction, recall across conversation turns, and contradiction superseding.
