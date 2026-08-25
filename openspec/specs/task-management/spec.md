# Task Management Specification

## Purpose

Enable users to create, list, prioritize, and complete actionable todos through natural language conversations on WhatsApp.

## Requirements

### Requirement: Task Creation
The system SHALL create tasks with an optional priority (`low`, `medium`, `high`, `urgent`), optional `due_date`, and optional association to an entity.

#### Scenario: Create task with due date
- **Given** a user message "Añade terminar la propuesta para el viernes a las 5pm"
- **When** the message is processed by the router
- **Then** a `tasks` record is inserted with `title = 'Terminar la propuesta'`, `status = 'pending'`, and `due_date` set to next Friday at 17:00 in user's timezone.
- **And** the assistant confirms task creation with due date.

### Requirement: Task Listing
The system SHALL retrieve and summarize pending tasks when requested.

#### Scenario: Query pending tasks
- **Given** 2 pending tasks for the user
- **When** the user asks "¿Qué tengo pendiente?"
- **Then** the assistant returns a formatted bulleted list of all pending tasks with their due dates.

### Requirement: Task Completion
The system SHALL update task status to `completed` and set `completed_at` to `NOW()` when the user indicates a task is done.

#### Scenario: Mark task as completed
- **Given** an existing pending task "Enviar contrato"
- **When** the user sends "Marca como completada la tarea de enviar el contrato"
- **Then** the task's `status` becomes `completed`
- **And** the assistant confirms the completion.
