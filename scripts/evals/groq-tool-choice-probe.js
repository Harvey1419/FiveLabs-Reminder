import 'dotenv/config';

const apiKey = process.env.OPENROUTER_API_KEY?.replace(/"/g, '').trim();
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is required.');
  process.exit(2);
}

const model = 'openai/gpt-oss-120b';
const provider = {
  order: ['groq'],
  only: ['groq'],
  allow_fallbacks: false,
  require_parameters: true,
};

const executeTurnTool = {
  type: 'function',
  function: {
    name: 'execute_turn',
    description: 'Mandatory canonical Hermes turn output. Ordinary conversation must use conversation.reply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              domain: { type: 'string', enum: ['conversation', 'reminder'] },
              action: { type: 'string' },
              content: { type: 'string' },
              schedule: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['relative_day_time'] },
                  dayOffset: { type: 'integer' },
                  hour: { type: 'integer' },
                  minute: { type: 'integer' },
                },
                required: ['kind'],
              },
            },
            required: ['domain', 'action'],
          },
        },
      },
      required: ['actions'],
    },
  },
};

const replyTool = {
  type: 'function',
  function: {
    name: 'reply_to_user',
    description: 'Use only for ordinary non-operational conversation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
  },
};

const variants = [
  { name: 'A_auto_execute_turn', tools: [executeTurnTool], toolChoice: 'auto' },
  { name: 'B_required_execute_turn', tools: [executeTurnTool], toolChoice: 'required' },
  {
    name: 'C_specific_execute_turn',
    tools: [executeTurnTool],
    toolChoice: { type: 'function', function: { name: 'execute_turn' } },
  },
  { name: 'D_required_execute_plus_reply', tools: [executeTurnTool, replyTool], toolChoice: 'required' },
  { name: 'E_auto_execute_plus_reply', tools: [executeTurnTool, replyTool], toolChoice: 'auto' },
];

const prompts = [
  'Hola hola',
  'Recuérdame llamar a Pedro mañana a las 5',
];

const repetitions = Number(process.env.GROQ_PROBE_REPETITIONS || 5);

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function runOnce(variant, userText) {
  const startedAt = Date.now();
  const payload = {
    model,
    provider,
    temperature: 0,
    max_tokens: 700,
    reasoning: { effort: 'low', exclude: true },
    messages: [
      {
        role: 'system',
        content: 'You are Hermes. Every response must use a provided tool. Never answer in prose outside a tool. Ordinary conversation uses conversation.reply inside execute_turn unless reply_to_user is available and appropriate.',
      },
      { role: 'user', content: userText },
    ],
    tools: variant.tools,
    tool_choice: variant.toolChoice,
  };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://fivelabs.co',
        'X-Title': 'Hermes Groq Tool Choice Probe',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    const choice = data?.choices?.[0] || {};
    const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
    return {
      ok: response.ok && choice?.finish_reason !== 'error',
      status: response.status,
      latencyMs: Date.now() - startedAt,
      finishReason: choice?.finish_reason || null,
      toolCalls: toolCalls.map((call) => call?.function?.name).filter(Boolean),
      proseChars: typeof choice?.message?.content === 'string' ? choice.message.content.length : 0,
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
      error: data?.error?.message || choice?.error?.message || (!response.ok ? raw.slice(0, 240) : null),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      finishReason: null,
      toolCalls: [],
      proseChars: 0,
      promptTokens: null,
      completionTokens: null,
      error: error?.message || String(error),
    };
  }
}

const rawResults = [];
for (const prompt of prompts) {
  for (const variant of variants) {
    for (let i = 0; i < repetitions; i += 1) {
      const result = await runOnce(variant, prompt);
      rawResults.push({ prompt, variant: variant.name, iteration: i + 1, ...result });
      console.log(JSON.stringify(rawResults.at(-1)));
    }
  }
}

const summary = [];
for (const prompt of prompts) {
  for (const variant of variants) {
    const rows = rawResults.filter((row) => row.prompt === prompt && row.variant === variant.name);
    const successfulToolCalls = rows.filter((row) => row.ok && row.toolCalls.length > 0);
    const executeTurnCalls = rows.filter((row) => row.ok && row.toolCalls.includes('execute_turn'));
    const replyCalls = rows.filter((row) => row.ok && row.toolCalls.includes('reply_to_user'));
    const latencies = rows.map((row) => row.latencyMs);
    summary.push({
      prompt,
      variant: variant.name,
      n: rows.length,
      providerSuccessRate: rows.filter((row) => row.ok).length / rows.length,
      anyToolRate: successfulToolCalls.length / rows.length,
      executeTurnRate: executeTurnCalls.length / rows.length,
      replyToolRate: replyCalls.length / rows.length,
      proseOnlyRate: rows.filter((row) => row.ok && row.toolCalls.length === 0 && row.proseChars > 0).length / rows.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      avgPromptTokens: Math.round(rows.reduce((sum, row) => sum + (row.promptTokens || 0), 0) / rows.length),
      errors: [...new Set(rows.map((row) => row.error).filter(Boolean))],
    });
  }
}

console.log('\n=== GROQ TOOL CHOICE SUMMARY ===');
console.table(summary);
console.log('\nJSON_SUMMARY=' + JSON.stringify(summary));
