# Proposal: Semantic and Persistent Memory Pipeline (Phase 3)

## Why

Phases 1 and 2 solved user identity, timezones, tasks, and entities. However, the assistant still suffers from cross-session amnesia: once messages fall outside the short-term 20-message window, the assistant forgets facts, decisions, and preferences (e.g. "Mi contador se llama Carlos", "La venta del carro con Juan por 51M").

This change implements a **hybrid persistent memory layer (Engram-inspired topic keys + relational storage + vector indexing)** that extracts durable facts asynchronously, resolves contradictions, and retrieves relevant context into the LLM prompt.

## What Changes

- [NEW] `src/db/schema.sql` — Enable `vector` extension, define `memories` table (with `topic_key`, `category`, `embedding`, `is_active`, `superseded_by`, temporal bounds) and PostgreSQL hybrid search function `match_memories`.
- [NEW] `src/db/memories.js` — Data access layer for memory persistence, retrieval, superseding, and GDPR forgetting.
- [NEW] `src/services/memoryService.js` — Extraction, deduplication, conflict resolution, and hybrid memory querying.
- [NEW] `src/workers/memoryExtractor.js` — Asynchronous background worker executed post-webhook turn to extract facts without blocking user replies.
- [REFACTORED] `src/ai/router.js` — Query relevant semantic memories during contextual response assembly.
- [REFACTORED] `src/webhook.js` — Trigger asynchronous memory extraction in background after sending WhatsApp confirmation.
- [NEW] Migration applied to Supabase database via Supabase MCP.

## Impact

| Area | Status |
|------|--------|
| `src/db/schema.sql` | MODIFIED (additive: `memories` table, `match_memories` function) |
| `src/db/memories.js` | NEW |
| `src/services/memoryService.js` | NEW |
| `src/workers/memoryExtractor.js` | NEW |
| `src/ai/router.js` | MODIFIED (retrieves memories for context) |
| `src/webhook.js` | MODIFIED (dispatches background extraction) |

## Non-Goals

- External calendar integrations (Google / Outlook OAuth) - deferred to Phase 4.
- Proactive outbound triggers without scheduled alarms - deferred to Phase 4.

## Capabilities

### New Capabilities
- `persistent-memory`: Automatic extraction of facts, preferences, and decisions.
- `contradiction-resolution`: Superseding outdated memories via `topic_key` and temporal validity.
- `semantic-retrieval`: Hybrid text and semantic recall of prior knowledge.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Memory extraction slows down WhatsApp reply | None | Memory extractor runs 100% asynchronously after HTTP 200 is dispatched. |
| Memory contains irrelevant or noisy facts | Low | Strict extraction prompt filtering out greetings, transient chit-chat, and passwords. |
