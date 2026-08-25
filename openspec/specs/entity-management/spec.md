# Entity Management Specification

## Purpose

Track named domain objects (people, companies, projects, assets, places) linked to user activities and conversations.

## Requirements

### Requirement: Entity Auto-Resolution
The system SHALL lazily create or associate named entities (such as "Juan", "Empresa X", "Venta del carro") when referenced in tasks or reminders.

#### Scenario: Link person to task
- **Given** a message "Recordar llamar a Carlos mañana sobre el presupuesto"
- **When** processed by the tool engine
- **Then** an entity record with `name = 'Carlos'` and `category = 'person'` is linked or created for the user
- **And** the task or reminder is associated with `entity_id`.
