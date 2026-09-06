# Hermes TempleLabs

AI-powered WhatsApp executive personal assistant and second brain using Kapso, Supabase (PostgreSQL + pgvector), and OpenRouter-routed GPT-OSS, GLM, Qwen, Gemini, and OpenAI embeddings.

## Stack

- **WhatsApp**: Kapso Cloud API (Meta Cloud WhatsApp Business)
- **AI Engine**: OpenRouter gateway with GPT-OSS 120B on Groq first, GLM 5.3 Flash on Baseten FP8 second, and Qwen 3.7 Flash on Alibaba only as a last resort
- **Multimodal**: GLM 5.3 Flash on Baseten FP8 for images; Gemini 2.5 Flash-Lite for fallback/PDFs, all through OpenRouter
- **Database**: Supabase (PostgreSQL + pgvector + pg_cron)
- **Calendar**: Google Calendar API (OAuth 2.0)
- **Payments**: Mercado Pago Preapproval Subscriptions
- **Runtime**: Node.js (ESM)

## Agent execution model

Hermes uses provider-native tool calling rather than asking the model to print a custom JSON plan. The model sees explicit schemas for the existing domains, while the application remains responsible for validation, tenant identity, ordering, and execution.

`User message → relevant context → native tool calls → backend validation/execution → ExecutionFacts/cards → grounded conversational response`

- Current explicit context outranks Working Memory, live snapshots, history, and persistent memory—in that order.
- Multiple requested tools are executed sequentially so mutations keep user order; each `ExecutionFact` is returned to the model inside a bounded agent loop so it can continue compound requests safely.
- Once a tool runs, factual cards remain backend-owned and are appended intact. The post-tool model response may add brief natural framing, while partial failures and provider outages fall back to deterministic `ExecutionFacts` composition.
- The former JSON `TurnPlan` shape is still accepted temporarily as a compatibility path for existing tests and rollback.

## Repository structure

```text
src/
├── app/                    # Process entrypoint and application bootstrap
├── agent/                  # Agent core, contracts, orchestration, providers, and tools
├── features/               # Application-level agenda and memory use cases
├── http/                   # Routes, rendered views, and inbound webhooks
├── infrastructure/         # Database access and persistence schema
├── integrations/           # External AI, Google, media, payment, and WhatsApp clients
├── jobs/                   # Schedulers and background workers
└── shared/                 # Cross-cutting utilities without feature ownership

tests/
├── unit/                   # Deterministic tests grouped by domain
├── integration/            # Isolated Supabase-backed contract tests grouped by domain
├── support/                # Test-only environment helpers
└── config/                 # Vitest configurations

scripts/
├── checks/                 # Environment and safety checks
├── dev/                    # Manual local-development utilities
└── evals/                  # Live production-agent evaluations
```

Files and folders use kebab-case. Imports point directly to the owning module; compatibility shims for obsolete paths are intentionally avoided so stale dependencies fail visibly during validation.

## Setup

1. **Install dependencies**
\`\`\`bash
npm install
\`\`\`

2. **Configure environment**
\`\`\`bash
cp .env.example .env
# Fill in your credentials
\`\`\`

3. **Run database schema** - Go to Supabase SQL Editor and run `src/infrastructure/database/schema.sql`.

4. **Start server**
\`\`\`bash
npm run dev
\`\`\`

5. **Expose locally with ngrok**
\`\`\`bash
npx ngrok http 3000
\`\`\`

6. **Configure Kapso webhook** - Set URL to your ngrok URL + `/webhook`.

## Usage

Send a WhatsApp message:
- "recuerda tomarme la pastilla en 1 hora"
- "remind me to call mom in 30 minutes"
- "lembre-me de beber água em 2 horas"

## Environment Variables

| Variable | Description |
|----------|-------------|
| GROQ_API_KEY | Optional Groq key used only for Whisper transcription; GPT-OSS is accessed through OpenRouter |
| OPENROUTER_API_KEY | Required single gateway key for text, embeddings, image/PDF understanding, and configured audio fallback |
| OPENROUTER_PRIMARY_MODEL | Primary text model (default: `openai/gpt-oss-120b`) |
| OPENROUTER_PRIMARY_PROVIDERS | Exact primary provider list (default: `groq`) |
| OPENROUTER_PRIMARY_REASONING_EFFORT | GPT-OSS reasoning effort (default: `medium`) |
| OPENROUTER_PRIMARY_TIMEOUT_MS | Maximum wait for GPT-OSS/Groq before GLM fallback (default: 9 seconds) |
| OPENROUTER_SECONDARY_MODEL | Secondary text model (default: `z-ai/glm-5.3-flash`) |
| OPENROUTER_SECONDARY_PROVIDERS | Exact secondary provider endpoint (default: `baseten/fp8`) |
| OPENROUTER_SECONDARY_REASONING_EFFORT | GLM reasoning effort (default: `low`) |
| OPENROUTER_SECONDARY_TIMEOUT_MS | Maximum wait for GLM/Baseten FP8 before Qwen fallback (default: 15 seconds) |
| OPENROUTER_LAST_RESORT_MODEL | Last-resort text model (default: `qwen/qwen3.7-flash`) |
| OPENROUTER_LAST_RESORT_PROVIDERS | Exact last-resort provider list (default: `alibaba`) |
| OPENROUTER_LAST_RESORT_TIMEOUT_MS | Maximum wait for Qwen/Alibaba (default: 12 seconds) |
| OPENROUTER_MEMORY_PRIMARY_MODEL / OPENROUTER_MEMORY_PRIMARY_PROVIDERS | Background memory candidate extractor (default: GPT-OSS 120B on Groq) |
| OPENROUTER_MEMORY_PRIMARY_REASONING_EFFORT / OPENROUTER_MEMORY_PRIMARY_TIMEOUT_MS | Memory-primary reasoning and timeout (defaults: `low`, 9 seconds) |
| OPENROUTER_MEMORY_SECONDARY_MODEL / OPENROUTER_MEMORY_SECONDARY_PROVIDERS | Memory fallback (default: GLM 5.3 Flash on Baseten FP8) |
| OPENROUTER_MEMORY_SECONDARY_TIMEOUT_MS | Maximum wait for the memory fallback (default: 15 seconds) |
| OPENROUTER_VISION_MODEL | Image-understanding model (default: `z-ai/glm-5.3-flash`) |
| OPENROUTER_VISION_PROVIDER | Exact OpenRouter image endpoint (default: `baseten/fp8`) |
| OPENROUTER_VISION_TIMEOUT_MS | Maximum wait for the primary GLM image request before the OpenRouter Gemini fallback (default: 15 seconds) |
| OPENROUTER_MAX_IMAGE_BYTES | Maximum attachment size accepted by the OpenRouter multimodal pipeline (default: 20 MB) |
| SUPABASE_URL / SUPABASE_SECRET | Supabase project credentials |
| SUPABASE_TEST_URL / SUPABASE_TEST_SECRET | Credentials for a separate, disposable Supabase project used only by integration tests; the runner refuses the production URL |
| KAPSO_API_KEY | Kapso access token |
| KAPSO_PHONE_NUMBER_ID | Kapso phone number ID |
| KAPSO_WEBHOOK_VERIFY_TOKEN | Token for webhook verification |
| PORT | Server port (default: 3005) |

## Tests and production gate

The suite is split by responsibility:

- `npm run test:unit` runs the deterministic offline suite. It never runs files named `*.integration.test.js`.
- `npm run test:integration` runs the legacy database-backed contract suites against `SUPABASE_TEST_URL` and `SUPABASE_TEST_SECRET`.
- `npm test` is the complete production gate and runs both suites in that order.

Integration tests intentionally fail fast when the isolated test credentials are missing. They also refuse to run when either test credential matches its production counterpart, because these suites create and delete records and must never target the production project. A green release gate therefore cannot silently skip database coverage.
