# WhatsApp Reminder Assistant

AI-powered WhatsApp reminder bot using Kapso, Supabase (PostgreSQL + pg_cron), and MiniMax.

## Stack

- **WhatsApp**: Kapso Cloud API
- **AI**: MiniMax (NLU for intent detection and entity extraction)
- **Database**: Supabase (PostgreSQL + pg_cron)
- **Runtime**: Node.js (ESM)

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

3. **Run database schema** - Go to Supabase SQL Editor and run `src/db/schema.sql`.

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
| DATABASE_URL | Supabase PostgreSQL connection string |
| MINIMAX_API_KEY | MiniMax API key |
| KAPSO_ACCESS_TOKEN | Kapso access token |
| KAPSO_PHONE_NUMBER_ID | Kapso phone number ID |
| KAPSO_WEBHOOK_VERIFY_TOKEN | Token for webhook verification |
| PORT | Server port (default: 3000) |
