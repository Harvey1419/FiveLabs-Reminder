import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Real provider, real prompt, real schema, real canonical validation and real
// orchestration. Only database reads and domain side effects are isolated.
// Never run this with a customer account or substitute another provider on failure.
vi.mock('../../src/agent/providers/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callChatCompletion: (messages, options) => actual.callChatCompletion(messages, {
    ...options, startStage: process.env.FOREGROUND_ACCEPTANCE_STAGE || 'primary',
  }) };
});
vi.mock('../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));
vi.mock('../../src/shared/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isAdminUser: vi.fn(() => false) };
});
vi.mock('../../src/agent/contracts/intent-contracts.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, validateTurnIntent: vi.fn(actual.validateTurnIntent) };
});

import { routeMessage } from '../../src/agent/orchestration/router.js';
import { executeTool } from '../../src/agent/tools/index.js';
import { clearWorkingMemory } from '../../src/agent/core/working-memory.js';
import { isAdminUser } from '../../src/shared/auth.js';


const stage = process.env.FOREGROUND_ACCEPTANCE_STAGE || 'primary';
const routes = {
  primary: ['openai/gpt-oss-120b', 'groq'],
  secondary: ['z-ai/glm-5.3-flash', 'baseten/fp8'],
  last_resort: ['qwen/qwen3.7-flash', 'alibaba'],
};
const [model, provider] = routes[stage] || [];
const realFetch = globalThis.fetch.bind(globalThis);
const user = { id: 'synthetic-acceptance', phone_number: '573000000001', timezone: 'America/Bogota', locale: 'es-CO' };
const reference = { requestTimeMs: Date.parse('2026-09-10T00:08:07.000Z') };
const summary = [];
const safeMetadata = (value) => typeof value === 'string'
  ? value.split(process.env.OPENROUTER_API_KEY || '__no_key__').join('[REDACTED]').slice(0, 160)
  : typeof value === 'number' && Number.isFinite(value) ? value : null;
let attempts;
let responses;
let caseName;

beforeAll(() => {
  if (!model || !process.env.OPENROUTER_API_KEY?.trim()) throw new Error('Live acceptance requires a known stage and OPENROUTER_API_KEY; missing credentials are NOT a pass.');
});
beforeEach((context) => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
  isAdminUser.mockReturnValue(false);
  attempts = [];
  responses = [];
  caseName = context.task.name;
  executeTool.mockImplementation(async ({ toolName, params }) => {
    if (toolName !== 'manage_reminder' || params.action !== 'create') throw new Error('Acceptance sandbox blocks unrelated tools.');
    return { success: true, complete: true, action: 'created_reminder', data: { timezone: user.timezone, items: params.items.map((item) => ({ id: `synthetic-${item.content}`, content: item.content, sendAt: item.targetTime })) } };
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const payload = JSON.parse(init.body);
    attempts.push(payload);
    // Fail closed BEFORE network I/O: only the selected OpenRouter route is allowed.
    if (url !== 'https://openrouter.ai/api/v1/chat/completions'
      || payload.model !== model || JSON.stringify(payload.provider?.only) !== JSON.stringify([provider])) {
      throw new Error('Acceptance blocked an independent fallback or unrelated network call.');
    }
    expect(payload.provider).toEqual({ order: [provider], only: [provider], allow_fallbacks: false, require_parameters: true });
    expect(payload.response_format.type).toBe('json_schema');
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
    const started = Date.now();
    const res = await realFetch(url, init);
    const data = await res.clone().json().catch(() => null);
    responses.push(data);
    const choice = data?.choices?.[0];
    const error = data?.error || choice?.error;
    // Report only reproducible protocol metadata. No key, prompts, content or reasoning.
    summary.push({ case: caseName, stage, requestedModel: model, requestedProvider: provider,
      reportedProvider: safeMetadata(data?.provider), generationId: safeMetadata(data?.id),
      httpStatus: res.status, finishReason: safeMetadata(choice?.finish_reason),
      errorType: safeMetadata(error?.metadata?.error_type ?? error?.type),
      completionTokens: safeMetadata(data?.usage?.completion_tokens),
      reasoningTokens: safeMetadata(data?.usage?.completion_tokens_details?.reasoning_tokens),
      latencyMs: Date.now() - started });
    return res;
  });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => writeFileSync(`foreground-acceptance-${stage}.json`, JSON.stringify(summary, null, 2)));

function assertCompleteDecision(count = 1) {
  expect(attempts).toHaveLength(count);
  expect(responses).toHaveLength(count);
  for (const data of responses) {
    expect(data?.error).toBeUndefined();
    expect(data?.choices?.[0]?.finish_reason).toBe('stop');
    expect(data?.choices?.[0]?.message?.tool_calls || []).toEqual([]);
    expect(data?.provider?.toLowerCase()).toContain(provider.split('/')[0]);
  }
}
function assertReminder(index, subject, at) {
  const item = executeTool.mock.calls[index]?.[0]?.params?.items?.[0];
  expect(item?.content.toLowerCase()).toContain(subject.toLowerCase());
  expect(item?.targetTime).toBe(at);
}
const tomorrow = (hour) => new Date(Date.UTC(2026, 8, 10, hour + 5, 0)).toISOString();

// Subjects are synthetic labels. Assertions compare known expected structures;
// no model judges another model and no production code parses these phrases.
describe(`live strict foreground acceptance: ${stage}`, () => {
  it('Hola hola', async () => {
    const result = await routeMessage('Hola hola', user, [], reference);
    assertCompleteDecision();
    expect(result.intent).toBe('chat');
    expect(result.confirmation.length).toBeGreaterThan(0);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])('keeps three different reminder hours associated with their subjects, repetition %i', async () => {
    const text = 'Mañana al mediodía recuérdame revisar Alfa; también mañana a las 9 de la mañana revisar Beta; y el viernes a las 3 de la tarde revisar Gamma. Son tres recordatorios.';
    const result = await routeMessage(text, user, [], reference);
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(result.executionFacts.every((fact) => fact.success)).toBe(true);
    assertReminder(0, 'Alfa', tomorrow(12));
    assertReminder(1, 'Beta', tomorrow(9));
    assertReminder(2, 'Gamma', '2026-09-11T20:00:00.000Z');
  });

  it('applies a shared time only to its stated requests', async () => {
    await routeMessage('Mañana a las 9 de la mañana recuérdame revisar Alfa y también revisar Beta. Quiero dos recordatorios a esa hora.', user, [], reference);
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(2);
    assertReminder(0, 'Alfa', tomorrow(9)); assertReminder(1, 'Beta', tomorrow(9));
  });

  it('replaces an explicitly corrected time without creating a duplicate', async () => {
    await routeMessage('Mañana a las 9 de la mañana, no, mejor a las 10 de la mañana, recuérdame revisar Alfa.', user, [], reference);
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(1);
    assertReminder(0, 'Alfa', tomorrow(10));
  });

  it('distinguishes the reminder time from the appointment date in its content', async () => {
    await routeMessage('Mañana a las 9 de la mañana recuérdame pedir la cita de Alfa para el viernes.', user, [], reference);
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(1);
    assertReminder(0, 'Alfa', tomorrow(9));
    expect(executeTool.mock.calls[0][0].params.items[0].content.toLowerCase()).toContain('viernes');
  });

  it('asks for a genuinely missing time without inventing a schedule', async () => {
    const result = await routeMessage('Recuérdame revisar Alfa.', user, [], reference);
    assertCompleteDecision();
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.plan.actions.some((action) => action.domain === 'clarification')).toBe(true);
  });

  it('completes two timed requests, asks only for the missing one, and continues without recreating the completed items', async () => {
    const text = 'Mañana al mediodía recuérdame revisar Alfa; a las 9 de la mañana revisar Beta; y también recuérdame revisar Gamma, para ese último todavía no te he indicado la hora.';
    const first = await routeMessage(text, user, [], { ...reference, inputModality: 'audio' });
    expect(executeTool).toHaveBeenCalledTimes(2);
    assertReminder(0, 'Alfa', tomorrow(12)); assertReminder(1, 'Beta', tomorrow(9));
    expect(first.executionFacts.filter((fact) => fact.requiresClarification)).toHaveLength(1);
    expect(first.confirmation.toLowerCase()).toContain('gamma');
    const history = [{ role: 'user', content: text }, { role: 'assistant', content: first.confirmation, entities: first.entities }];
    const second = await routeMessage('Gamma mañana a las 3 de la tarde.', user, history, reference);
    assertCompleteDecision(2);
    expect(executeTool).toHaveBeenCalledTimes(3);
    assertReminder(2, 'Gamma', tomorrow(15));
    expect(second.executionFacts).toHaveLength(1);
  });

  it.each([1, 6, 12])('returns a complete %i-action nullable batch, not a truncated prefix', async (count) => {
    const clauses = Array.from({ length: count }, (_, index) => `a las ${String(index + 6).padStart(2, '0')}:00 recuérdame revisar Prueba${index + 1}`);
    const result = await routeMessage(`Mañana: ${clauses.join('; ')}. Crea un recordatorio separado para cada solicitud.`, user, [], reference);
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(count);
    expect(result.executionFacts).toHaveLength(count);
    for (let index = 0; index < count; index += 1) assertReminder(index, `Prueba${index + 1}`, tomorrow(index + 6));
  });
});
