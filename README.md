# Hermes TempleLabs

AI-powered WhatsApp executive personal assistant and second brain using Kapso, Supabase (PostgreSQL + pgvector), OpenRouter, Google Calendar, and Mercado Pago.

## Stack

- **WhatsApp**: Kapso Cloud API (Meta Cloud WhatsApp Business)
- **AI Engine**: OpenRouter with GPT-OSS 120B on Groq first, GLM 5.3 Flash on Baseten FP8 second, and Qwen 3.7 Flash on Alibaba as last resort
- **Multimodal**: GLM 5.3 Flash on Baseten FP8 for images; Gemini 2.5 Flash-Lite as fallback/PDF path through OpenRouter
- **Database**: Supabase (PostgreSQL + pgvector + pg_cron)
- **Calendar**: Google Calendar API (OAuth 2.0)
- **Payments**: Mercado Pago Preapproval Subscriptions
- **Runtime**: Node.js (ESM)

## Agent execution model

Hermes has one model-facing execution boundary: `execute_turn`. The model expresses a compact semantic `TurnIntent` composed of domain + action + user-level arguments. Node then enriches only deterministic runtime context and executes the existing domain tools.

`User message → relevant context → one Hermes decision → TurnIntent → deterministic runtime normalization → domain tools → ExecutionFacts/cards → response`

Key properties:

- The model does not produce internal IDs, operation sequences, evidence quotes, manifests, or backend-specific CRUD plans.
- Node remains authoritative for tenant identity, ownership, permissions, database truth, time arithmetic, timezone handling, confirmation state, entity resolution, and execution results.
- Normal conversation and ordinary actions use one foreground model decision. A second semantic verification is reserved only for transitions of an already-staged pending proposal.
- Generic agenda questions use Unified Agenda; explicitly single-domain questions can use reminders, tasks, or Google Calendar directly.
- Runtime normalization may add deterministic context Node already knows, such as the local year of an explicit date, the position represented by “último”, or unchanged Calendar fields required for a patch. It never changes the semantic domain/action selected by Hermes.
- Domain tools execute sequentially so compound mutations observe prior outcomes and preserve user order.
- Backend cards are the source of truth for action results and are returned intact. A tiny synthesis pass is allowed only when part of a mixed request was deliberately excluded.
- Attachment extraction without a trusted user caption never receives backend tools.

## Repository structure

```text
src/
├── app/                    # Process entrypoint and application bootstrap
├── agent/
│   ├── contracts/          # TurnIntent schema and stable tool names
│   ├── core/               # Prompt, Working Memory, ExecutionFacts
│   ├── orchestration/      # Router, intent normalization, deterministic executor
│   ├── providers/          # OpenRouter routing/fallback and pending verification
│   └── tools/              # Authoritative domain tools
├── features/               # Agenda and memory application use cases
├── http/                   # Routes, views, and inbound webhooks
├── infrastructure/         # Database access and persistence schema
├── integrations/           # AI/media, Google, payment, and WhatsApp clients
├── jobs/                   # Schedulers and background workers
└── shared/                 # Cross-cutting deterministic utilities

tests/
├── unit/                   # Offline deterministic contracts and domain behavior
├── integration/            # Supabase-backed behavior tests using an isolated test project
├── support/                # Test-only environment helpers
└── config/                 # Vitest configurations

scripts/
├── checks/                 # Environment and safety checks
├── dev/                    # Manual local-development utilities
└── evals/                  # Live production-agent evaluations
```

Files and folders use kebab-case. Imports point directly to the owning module; obsolete compatibility shims are intentionally avoided so stale dependencies fail visibly.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# Fill in your credentials
```

3. Run `src/infrastructure/database/schema.sql` in the Supabase SQL Editor.

4. Start the server:

```bash
npm run dev
```

5. Expose locally if needed:

```bash
npx ngrok http 3000
```

6. Configure the Kapso webhook to point to your public URL + `/webhook`.

## Environment variables

| Variable | Description |
|----------|-------------|
| GROQ_API_KEY | Optional Groq key used for Whisper transcription; foreground GPT-OSS is accessed through OpenRouter |
| OPENROUTER_API_KEY | Required gateway key for configured AI routes |
| OPENROUTER_PRIMARY_MODEL | Primary text model (default: `openai/gpt-oss-120b`) |
| OPENROUTER_PRIMARY_PROVIDERS | Exact primary provider list (default: `groq`) |
| OPENROUTER_PRIMARY_REASONING_EFFORT | Primary reasoning effort (default: `medium`) |
| OPENROUTER_PRIMARY_TIMEOUT_MS | Maximum wait before fallback (default: 9 seconds) |
| OPENROUTER_SECONDARY_MODEL | Secondary text model (default: `z-ai/glm-5.3-flash`) |
| OPENROUTER_SECONDARY_PROVIDERS | Exact secondary endpoint (default: `baseten/fp8`) |
| OPENROUTER_SECONDARY_REASONING_EFFORT | Secondary reasoning effort (default: `low`) |
| OPENROUTER_SECONDARY_TIMEOUT_MS | Maximum wait before last-resort fallback (default: 15 seconds) |
| OPENROUTER_STRICT_SECONDARY_MODEL / OPENROUTER_STRICT_SECONDARY_PROVIDERS | Strict foreground fallback (default: GPT-OSS 120B on `cerebras/fp16`) |
| OPENROUTER_STRICT_SECONDARY_REASONING_EFFORT | Strict secondary reasoning effort (default: `medium`) |
| OPENROUTER_STRICT_FALLBACK_MODEL / OPENROUTER_STRICT_FALLBACK_PROVIDERS | Final strict foreground fallback (default: GLM 5.3 Flash on `baseten/fp8`) |
| OPENROUTER_STRICT_FALLBACK_REASONING_EFFORT / OPENROUTER_STRICT_FALLBACK_TIMEOUT_MS | Final strict fallback reasoning and timeout |
| OPENROUTER_LAST_RESORT_MODEL | Last-resort text model (default: `qwen/qwen3.7-flash`) |
| OPENROUTER_LAST_RESORT_PROVIDERS | Exact last-resort provider list (default: `alibaba`) |
| OPENROUTER_LAST_RESORT_TIMEOUT_MS | Last-resort timeout |
| OPENROUTER_MEMORY_PRIMARY_MODEL / OPENROUTER_MEMORY_PRIMARY_PROVIDERS | Background memory extraction route |
| OPENROUTER_MEMORY_PRIMARY_REASONING_EFFORT / OPENROUTER_MEMORY_PRIMARY_TIMEOUT_MS | Memory-primary reasoning and timeout |
| OPENROUTER_MEMORY_SECONDARY_MODEL / OPENROUTER_MEMORY_SECONDARY_PROVIDERS | Background memory fallback |
| OPENROUTER_MEMORY_SECONDARY_TIMEOUT_MS | Memory fallback timeout |
| OPENROUTER_VISION_MODEL | Image-understanding model |
| OPENROUTER_VISION_PROVIDER | Exact image provider endpoint |
| OPENROUTER_VISION_TIMEOUT_MS | Primary image timeout |
| OPENROUTER_MAX_IMAGE_BYTES | Maximum attachment size accepted by the multimodal pipeline |
| SUPABASE_URL / SUPABASE_SECRET | Production Supabase credentials |
| SUPABASE_TEST_URL / SUPABASE_TEST_SECRET | Separate disposable Supabase project used only by integration tests |
| KAPSO_API_KEY | Kapso access token |
| KAPSO_PHONE_NUMBER_ID | Kapso phone number ID |
| KAPSO_WEBHOOK_VERIFY_TOKEN | Webhook verification token |
| PORT | Server port (default: 3005) |

## Tests and production gate

- `npm run test:unit` runs the deterministic offline suite.
- `npm run test:integration` runs database-backed contract suites against `SUPABASE_TEST_URL` and `SUPABASE_TEST_SECRET`.
- `npm test` runs both suites in that order.
- `npm run test:agent-live` runs live production-agent evaluations.

Integration tests fail fast when isolated test credentials are missing and refuse to run when test credentials point to the production Supabase project.
