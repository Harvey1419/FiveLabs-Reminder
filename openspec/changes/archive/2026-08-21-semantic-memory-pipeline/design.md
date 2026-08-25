# Design: Semantic and Persistent Memory Pipeline (Phase 3)

## Context

To fulfill the product vision of a true personal assistant, Reminder must retain and accurately recall information shared weeks or months prior.

## Architectural Decisions

### Decision 1: Hybrid Memory Store in PostgreSQL
- Rather than maintaining an external vector database, we use PostgreSQL's `memories` table with:
  1. `topic_key` for exact and evolving state upserts (Engram pattern).
  2. Full-text search index (`tsvector`) for exact keyword and name recall.
  3. `pgvector` column for semantic cosine similarity search.
  4. Temporal fields (`valid_from`, `valid_until`, `is_active`, `superseded_by`) for contradiction resolution.

### Decision 2: Asynchronous Out-of-Band Memory Extraction
- Extracting facts through an LLM introduces 300–800ms of latency.
- To keep WhatsApp message responses instant ($<1\text{s}$), the extractor is triggered as an asynchronous background worker after the HTTP response and WhatsApp confirmation are already sent.

### Decision 3: Contradiction & Superseding Protocol
- When the extractor identifies a fact that updates an existing topic (e.g. "Me mudé a Barranquilla" when `profile/location` had "Vive en Bogotá"):
  1. The existing active memory with `topic_key = 'profile/location'` is updated: `is_active = FALSE`, `superseded_by = <new_memory_id>`.
  2. The new memory is inserted with `is_active = TRUE`.

## Sequence Diagram

```text
User: "Estoy vendiendo mi carro con Juan por 51M y quedó pendiente el peritaje"
       │
       ▼
[src/webhook.js] ──► Immediate Bot Reply: "Entendido! Lo tengo presente."
       │
       ▼ (Asynchronous Background Trigger)
[src/workers/memoryExtractor.js]
  ├── Call extraction prompt on turn
  ├── Extracted Fact:
  │   - topic_key: "project/car_sale"
  │   - category: "decision"
  │   - content: "El usuario está vendiendo su carro a Juan por 51 millones, pendiente de peritaje"
  └── Upsert into Supabase `memories` (topic_key = "project/car_sale")

Weeks Later...
User: "¿En qué iba lo del carro?"
       │
       ▼
[src/ai/router.js]
  ├── Query `match_memories` for user
  ├── Retrieve: "El usuario está vendiendo su carro a Juan por 51 millones, pendiente de peritaje"
  ├── Injected into Context Prompt
  └── Bot Reply: "Lo último que acordaste con Juan fue la venta por 51 millones y estaba pendiente el peritaje. ¿Quieres que hagamos seguimiento?"
```
