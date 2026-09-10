import { it, expect } from 'vitest';
import { getStructuredTurnSchema } from '../../src/agent/contracts/foreground-turn-schema.js';
import { buildAgentCorePrompt } from '../../src/agent/core/agent-core.js';
it('diagnostic schema compilation probes', async () => {
  const key = process.env.OPENROUTER_API_KEY;
  expect(Boolean(key)).toBe(true);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  for (const variant of ['reference', 'constant', 'typed_null_union']) {
    const schema = getStructuredTurnSchema({ isAdmin: true });
    const [reminder, other] = schema.properties.actions.items.anyOf;
    const [create, reminderOther] = reminder.anyOf;
    for (const temporal of create.properties.schedule.anyOf) delete temporal.anyOf;
    for (const branch of [create, reminderOther]) {
      if (variant === 'reference') { schema.$defs = { reminderDomain: { type: 'string', enum: ['reminder'] } }; branch.properties.domain = { $ref: '#/$defs/reminderDomain' }; }
      if (variant === 'constant') branch.properties.domain = { type: 'string', const: 'reminder' };
      if (variant === 'typed_null_union') branch.properties.domain = { type: 'string', anyOf: [{ type: 'string', enum: ['reminder'] }, { type: 'null' }] };
    }
    schema.properties.actions.items = { anyOf: [{ anyOf: [create, reminderOther] }, other] };
    const prompt = buildAgentCorePrompt({ nowStr: '2026-09-09 18:00', nowHumanStr: 'miércoles 9 de septiembre de 2026', timezone: 'America/Bogota', isAdmin: true, isPro: true, displayName: 'Prueba', memoryHints: '' });
    const payload = { model: 'openai/gpt-oss-120b', messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'Recuérdame revisar Alfa en 15 minutos y Beta en 30 minutos.' }], max_tokens: 8192, temperature: 0, reasoning: { effort: 'medium', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'hermes_turn_intent', strict: true, schema } }, provider: { order: ['groq'], only: ['groq'], allow_fallbacks: false, require_parameters: true } };
    const start = Date.now();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    const choice = data.choices?.[0];
    console.log('SCHEMA_PROBE ' + JSON.stringify({ variant, status: response.status, id: data.id, provider: data.provider, latencyMs: Date.now()-start, finish: choice?.finish_reason, content: choice?.message?.content, error: data.error || choice?.error }).split(key).join('[REDACTED]'));
  }
}, 80000);
