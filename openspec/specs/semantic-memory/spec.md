# Semantic Memory Specification

## Purpose

Enable the assistant to retain durable facts, user preferences, and evolving project decisions across arbitrary conversation boundaries.

## Requirements

### Requirement: Fact Extraction
The system SHALL identify and extract facts, decisions, and preferences from conversation exchanges asynchronously.

#### Scenario: User shares an enduring fact
- **Given** user message "Mi contador se llama Carlos y hablamos los viernes"
- **When** the background memory worker runs
- **Then** a memory record is saved with `category = 'fact'`, `topic_key = 'accountant'`, and `content = 'El contador del usuario se llama Carlos y hablan los viernes'`.

### Requirement: Memory Recall
The system SHALL retrieve relevant memories when the user asks a question about prior facts.

#### Scenario: User asks about prior fact
- **Given** an existing active memory for `accountant`
- **When** the user asks "¿Cómo se llama mi contador?"
- **Then** the relevant memory is retrieved and injected into the prompt
- **And** the assistant replies with the name "Carlos".

### Requirement: Contradiction & Superseding
The system SHALL deactivate older conflicting memories when an update is learned.

#### Scenario: Fact update supersedes old fact
- **Given** an existing active memory "El usuario vive en Bogotá" (`topic_key = 'location'`)
- **When** the user says "Me mudé a Barranquilla"
- **Then** the previous memory has `is_active = FALSE` and `superseded_by` set to the new memory ID
- **And** only the new memory "El usuario vive en Barranquilla" is retrieved for future queries.
