# Tasks: Task and Entity Tools (Phase 2)

## 1. Database Schema & Migration

- [x] 1.1 Update `src/db/schema.sql` to define `entities` and `tasks` tables with indexes and constraints.
- [x] 1.2 Apply migration to Supabase live database via Supabase MCP `apply_migration`.

## 2. Data Access Layers

- [x] 2.1 Create `src/db/entities.js` implementing `getOrCreateEntity(userId, name, category, metadata)`, `findEntities(userId, search)`, `getEntityById(id)`.
- [x] 2.2 Create `src/db/tasks.js` implementing `createTask({ userId, title, description, priority, dueDate, entityId })`, `getTasks({ userId, status, limit })`, `completeTask(userId, taskIdOrTitle)`, `updateTask(userId, taskId, updates)`.
- [x] 2.3 Export entities and tasks modules from `src/db/index.js`.

## 3. Tool Execution Engine

- [x] 3.1 Create `src/ai/tools.js` with tool schema definitions, tool dispatcher (`executeTool`), and result formatters for `manage_task`, `create_reminder`, `manage_entity`, and `get_pending_summary`.

## 4. Router Integration

- [x] 4.1 Update `src/ai/router.js` to use tool calling prompts, execute selected tools, and return formatted confirmations.

## 5. Verification & Tests

- [x] 5.1 Run automated end-to-end test script verifying task creation, listing, completion, and entity association.
- [x] 5.2 Verify that traditional reminder scheduling continues to work flawlessly.
