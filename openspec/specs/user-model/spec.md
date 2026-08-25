# User Model Specification

## Purpose

Provide deterministic identity, timezone, and preference isolation per WhatsApp phone number. Every inbound message resolves to a unique `user` record that dictates time offset calculations, localization, and future task/memory ownership.

## Requirements

### Requirement: User Resolution
The system SHALL resolve or lazily create a `users` record for each distinct WhatsApp `phone_number` upon receiving a webhook payload.

#### Scenario: First-time user creation
- **Given** an inbound WhatsApp message from a previously unknown phone number `+573001234567`
- **When** `getOrCreateUserByPhone('+573001234567')` is invoked
- **Then** a new record is created in `users` with `phone_number = '+573001234567'`, `timezone = 'America/Bogota'`, and `locale = 'es-CO'`
- **And** subsequent calls return the existing user record without inserting duplicates.

### Requirement: Timezone Coherence
The router and scheduler SHALL perform date/time formatting and relative offsets using the resolved user's `timezone`, rather than the host environment's system timezone.

#### Scenario: User in Colombia requesting a reminder on UTC server
- **Given** a user with `timezone = 'America/Bogota'` (UTC-5)
- **And** the server running in UTC (00:00)
- **When** the user sends "recuérdame a las 8:00 pm pagar servicios"
- **Then** the LLM system prompt reflects the current Colombian time
- **And** the computed `send_at` in the `reminders` table corresponds to 20:00 Colombian time (01:00 UTC next day).

### Requirement: Backward Compatibility
The system MUST maintain existing `phone_number` fields and data in `messages` and `reminders` while populating the foreign key `user_id` when available.
