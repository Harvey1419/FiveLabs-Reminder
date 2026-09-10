import { it, expect } from 'vitest';
import { getStructuredTurnSchema } from '../../src/agent/contracts/foreground-turn-schema.js';

it('diagnostic schema compilation probes', async () => {
  const key = process.env.OPENROUTER_API_KEY;
  expect(Boolean(key)).toBe(true);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models/qwen/qwen3.7-flash/endpoints', { headers });
  const catalog = await catalogResponse.json();
  console.log('CAPABILITIES ' + JSON.stringify({ status: catalogResponse.status, endpoints: catalog.data?.endpoints?.map((endpoint) => ({ provider: endpoint.provider_name, tag: endpoint.tag, parameters: endpoint.supported_parameters, maxCompletionTokens: endpoint.max_completion_tokens })) }));
  const variants = ['nested', 'object_union', 'object_union_wrapped_domain', 'create_partition'];
  for (const variant of variants) {
    const schema = getStructuredTurnSchema({ isAdmin: true });
    const [create, reminderOther, other] = schema.properties.actions.items.anyOf;
    const hideDomain = (branch) => { branch.properties.domain = { anyOf: [branch.properties.domain] }; return branch; };
    if (variant === 'nested') schema.properties.actions.items.anyOf = [{ anyOf: [hideDomain(create), hideDomain(reminderOther)] }, other];
    if (variant === 'object_union' || variant === 'object_union_wrapped_domain') {
      const parent = structuredClone(reminderOther);
      parent.properties.action = { type: 'string' };
      parent.anyOf = [create, reminderOther];
      if (variant === 'object_union_wrapped_domain') parent.anyOf.forEach(hideDomain);
      schema.properties.actions.items.anyOf = [parent, other];
    }
    if (variant === 'create_partition') {
      const nonCreate = structuredClone(other);
      nonCreate.properties.domain = { type: 'string', enum: [...other.properties.domain.enum, 'reminder'] };
      nonCreate.properties.action = { type: 'string', enum: ['reply','read','update','cancel','acknowledge','list','add_advance','complete','delete','upsert','rename','merge','deduplicate','search','next','connect','disconnect','save','forget','link','status','execute','discard','revise','request','metrics'] };
      const otherCreate = structuredClone(other);
      otherCreate.properties.action = { type: 'string', enum: ['create'] };
      const parent = structuredClone(otherCreate);
      parent.properties.domain = { type: 'string', enum: ['reminder',...otherCreate.properties.domain.enum] };
      const hideAction = (branch) => { branch.properties.action = { anyOf: [branch.properties.action] }; return branch; };
      parent.anyOf = [hideAction(create),hideAction(otherCreate)];
      hideDomain(parent); hideDomain(nonCreate);
      schema.properties.actions.items.anyOf = [parent,nonCreate];
    }
    const payload = { model: 'openai/gpt-oss-120b', messages: [{ role: 'system', content: 'Return a structured conversation.reply greeting, with null for inapplicable fields.' }, { role: 'user', content: 'Hola hola' }], max_tokens: 2048, temperature: 0, reasoning: { effort: 'medium', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'hermes_turn_intent', strict: true, schema } }, provider: { order: ['groq'], only: ['groq'], allow_fallbacks: false, require_parameters: true } };
    const start = Date.now();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    const choice = data.choices?.[0];
    console.log('SCHEMA_PROBE ' + JSON.stringify({ variant, status: response.status, id: data.id, provider: data.provider, latencyMs: Date.now()-start, finish: choice?.finish_reason, content: choice?.message?.content, error: data.error || choice?.error }).split(key).join('[REDACTED]'));
  }
}, 80000);
