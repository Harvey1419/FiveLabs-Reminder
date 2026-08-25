# Proposal: Task and Entity Tools (Phase 2)

## Why

In the current implementation, the assistant only understands atomic reminder intents and falls back to generic chat for anything else. A real personal assistant needs to:
1. **Manage Actionable Tasks**: Track todos with priorities, due dates, statuses (`pending`, `completed`), and entity associations without forcing everything to be an immediate notification alarm.
2. **Track Entities**: Model people, companies, and projects (e.g. "Juan", "Venta del carro") so tasks and notes attach to real domain objects.
3. **Structured Tool Execution Engine**: Transition from unstructured JSON extraction to a extensible Tool Calling pipeline that routes and executes actions deterministically.

## What Changes

- [NEW] `src/db/schema.sql` — Add `entities` table (`id`, `user_id`, `name`, `category`, `metadata`, timestamps) and `tasks` table (`id`, `user_id`, `entity_id`, `title`, `description`, `status`, `priority`, `due_date`, `completed_at`, timestamps).
- [NEW] `src/db/tasks.js` — Data access for creating, querying, updating, and completing tasks per user.
- [NEW] `src/db/entities.js` — Data access for creating, finding, and updating entities per user.
- [NEW] `src/ai/tools.js` — Tool definitions and deterministic executors:
  - `create_reminder(params)`
  - `manage_task(params)` (`create`, `list`, `complete`, `update`)
  - `manage_entity(params)` (`create`, `find`, `link`)
- [REFACTORED] `src/ai/router.js` — Upgrade LLM orchestration to multi-intent / tool-planning pipeline with schema validation.
- [NEW] Migration applied to Supabase database via Supabase MCP.

## Impact

| Area | Status |
|------|--------|
| `src/db/schema.sql` | MODIFIED (additive: `entities`, `tasks`) |
| `src/db/tasks.js` | NEW |
| `src/db/entities.js` | NEW |
| `src/ai/tools.js` | NEW |
| `src/ai/router.js` | MODIFIED (routes to tool executors) |
| `src/webhook.js` | UNCHANGED (already passes `user` and handles responses) |
| `src/scheduler.js` | UNCHANGED |

## Non-Goals

- Vector embedding search (`pgvector`) and background memory extractor (deferred to Phase 3: `semantic-memory-pipeline`).
- Proactive follow-ups engine (deferred to Phase 4).

## Capabilities

### New Capabilities
- `task-management`: Create, list, update, and complete tasks with priority and due date awareness.
- `entity-tracking`: Resolve and link named entities (people, projects, companies) to user actions.
- `tool-engine`: Modular, extensible tool definition and execution layer.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Ambiguity between creating a task vs an alarm reminder | Low | Prompt instructs: tasks are todos/projects with or without deadline; reminders are explicit timed notifications ("recuérdame a las X"). |
| Tool execution throws unexpected exception | Low | Tool executor catches all errors and returns friendly localized error messages. |

## Rollback Plan

1. Revert changes in `src/ai/router.js`.
2. Delete `src/ai/tools.js`, `src/db/tasks.js`, `src/db/entities.js`.
3. Existing `reminders` and `messages` tables remain fully functional.
