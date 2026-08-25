# Design: Task and Entity Tools (Phase 2)

## Context

Phase 1 established multi-tenant user identity and timezone isolation. Phase 2 equips Reminder with structured data storage for Tasks and Entities, coordinated through a Tool Execution Engine.

## Architectural Decisions

### Decision 1: Relational Schema for Tasks and Entities
- `tasks`: Explicitly separates actionable todos from time-based notification alarms (`reminders`). Tasks have statuses (`pending`, `completed`, `cancelled`), priorities (`low`, `medium`, `high`, `urgent`), and optional `due_date`.
- `entities`: Normalizes domain objects (people, companies, projects, assets). Allows linking tasks to specific entities via `entity_id` and storing arbitrary structured facts in `metadata` JSONB.

### Decision 2: Tool Execution Engine (`src/ai/tools.js`)
Instead of ad-hoc `if-else` blocks in `router.js`, all actions are registered in a centralized tool registry:
```text
Available Tools:
- create_reminder: Schedule a direct timed alarm notification
- manage_task: Create, query, complete, or update todos
- manage_entity: Register or search domain entities (people, projects, etc.)
- get_pending_summary: Provide structured overview of pending tasks and reminders
```

### Decision 3: Deterministic Tool Execution Loop
1. Router prompts LLM with available tools, current time, user profile, and conversation context.
2. LLM selects tool and emits JSON arguments.
3. Tool execution engine runs the deterministic database operation.
4. If a tool completes, its structured result generates a natural confirmation message in the user's language.

## Data Flow Diagram

```text
User Message ("Añade terminar la propuesta para el viernes con Juan")
      │
      ▼
[src/ai/router.js]
  ├── Build system prompt with Tool Definitions & Time Anchor
  ├── Call LLM (MiniMax)
  ▼
Tool Selection:
  tool: "manage_task"
  args: {
    action: "create",
    title: "Terminar la propuesta",
    dueDate: "2026-08-28T17:00:00-05:00",
    entityName: "Juan",
    entityCategory: "person"
  }
      │
      ▼
[src/ai/tools.js] ──► [src/db/entities.js] (Find/Create "Juan")
                  ──► [src/db/tasks.js] (Insert task with entity_id)
      │
      ▼
Formatted Confirmation: "Listo! Creé la tarea 'Terminar la propuesta' para el viernes con Juan 📋"
```
