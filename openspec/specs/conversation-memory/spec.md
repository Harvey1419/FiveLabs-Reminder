# Conversation Memory Specification

## Purpose

Bounded, per-phone conversation history (Level 1 working memory) so the assistant responds with awareness of prior turns. The `messages` table persists every user message and assistant reply; the router sends a bounded history slice to MiniMax. The reminder flow is **frozen** and MUST continue to work unchanged.

## Requirements

### Requirement: Message Persistence

The system SHALL save every user message and assistant reply to `messages` with `phone_number`, `role`, `content`, `intent` (nullable for `assistant`), `entities` (JSONB, nullable), and `created_at`. Saves MUST be best-effort: errors MUST be logged and MUST NOT break webhook delivery.

#### Scenario: Both turns are saved

- **Given** a message "hola" from `+5491133334444`
- **When** the router returns `{intent: "general_chat", entities: {}, response: "¡Hola! ¿En qué te ayudo?"}`
- **Then** two rows exist: one `role='user'`/`content='hola'`; one `role='assistant'`/`content='¡Hola! ¿En qué te ayudo?'`/`intent='general_chat'`
- **And** the user row's `created_at` precedes the assistant row

### Requirement: History Retrieval

The system SHALL expose `getRecentMessages(phone, limit)` returning the most recent N messages, ordered by `created_at` ASC. Default `limit` SHALL be 20, hard-capped at 100.

#### Scenario: Default limit returns last 20

- **Given** 25 messages stored for `+5491133334444`
- **When** `getRecentMessages('+5491133334444')` is called
- **Then** the response contains exactly 20 messages

### Requirement: Context Injection

The router SHALL pass the most recent N messages as prior turns in the MiniMax `messages` array, shaped `[system, ...history, newUser]`. The `system` prompt and `response_format: { type: 'json_object' }` MUST remain unchanged.

#### Scenario: Follow-up uses prior turn context

- **Given** the user asked "¿qué día es hoy?" and the assistant replied "Hoy es martes 17 de junio"
- **When** the user sends "y mañana?"
- **Then** the MiniMax request includes those two prior turns before the new user message
- **And** the reply references "mañana" relative to that date

### Requirement: Reminder Regression

The reminder flow — `send_at` calculation, `reminders` insert, in-process scheduler, Kapso send — MUST remain functionally unchanged.

#### Scenario: One-minute reminder

- **Given** the user sends "recuérdame en 1 minuto que debo sacar la basura"
- **When** the webhook processes the message
- **Then** a `reminders` row is created with `send_at ≈ now + 60s` and `content` referencing "sacar la basura"
- **And** the user receives a WhatsApp message from the bot ~1 minute later via Kapso

#### Scenario: Ten-day reminder

- **Given** the user sends "recuerda en 10 días llamar al médico"
- **When** the webhook processes the message
- **Then** a `reminders` row is created with `send_at ≈ now + 10 days` and the message is delivered at that time

### Requirement: Resilience and Stateless Fallback

If `getRecentMessages` throws, times out, or returns an empty array, the router MUST still produce a response and the webhook MUST still send a reply. Failures SHALL be logged.

#### Scenario: History fetch throws — reminder still works

- **Given** `getRecentMessages` rejects with a database error
- **When** the user sends "recuérdame em 5 minutos comprar leite"
- **Then** the router runs with an empty history, a `reminders` row is created, the assistant confirms the reminder, and the error is logged

### Requirement: Data Integrity Constraints

The `messages` table SHALL enforce: `role IN ('user', 'assistant')` via CHECK; `phone_number` and `content` NOT NULL; `created_at` defaulting to `NOW()`. An index on `(phone_number, created_at DESC)` SHALL exist.

#### Scenario: Invalid role is rejected

- **Given** a direct insert into `messages` with `role = 'system'`
- **When** the insert is executed
- **Then** the database rejects it with a CHECK constraint violation

### Requirement: Privacy Boundary

The context window sent to MiniMax SHALL contain only messages from the same `phone_number` as the current request.

#### Scenario: Two phones do not see each other's history

- **Given** user A (`+5491100000000`) and user B (`+5491199999999`) each have 10 rows in `messages`
- **When** user A sends a new message
- **Then** the MiniMax request for user A contains only user A's prior turns
