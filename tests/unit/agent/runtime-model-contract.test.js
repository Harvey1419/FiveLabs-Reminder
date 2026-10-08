import { getCanonicalOperations, parseCanonicalOperation } from '../../../src/agent/contracts/intent-contracts.js';
import { TURN_LANGUAGE_POLICY } from '../../../src/agent/contracts/response-policy.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));
vi.mock('../../../src/shared/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isAdminUser: vi.fn(() => false) };
});
vi.mock('../../../src/agent/contracts/intent-contracts.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, validateTurnIntent: vi.fn(actual.validateTurnIntent) };
});

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { clearWorkingMemory, getWorkingMemory } from '../../../src/agent/core/working-memory.js';
import { EXECUTE_TURN_DESCRIPTION, TURN_INTENT_SCHEMA, validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { getActiveAgentRun } from '../../../src/agent/core/agent-run.js';
import { isAdminUser } from '../../../src/shared/auth.js';

describe('mandatory runtime model contract', () => {
  it('requires strict TurnIntent JSON on the initial Hermes decision and has no semantic recovery round', () => {
    const source = readFileSync(new URL('../../../src/agent/orchestration/router-core.js', import.meta.url), 'utf8');

    expect(source).toContain("type: 'json_schema'");
    expect(source).toContain('strict: true');
    expect(source).toContain("toolChoice: 'none'");
    expect(source).not.toContain('structured_recovery');
    expect(source).not.toContain('buildRecoveryMessages');
    expect(source).toContain('limit: 3');
    expect(source).toContain('MAX_HISTORY_CHARS');
  });
});

const canonicalSnapshot = structuredClone(TURN_INTENT_SCHEMA);
const user = {
  id: 'structured-user', phone_number: '573001114455', timezone: 'America/Bogota', locale: 'es-CO',
};
const turnOptions = { requestTimeMs: Date.parse('2026-09-09T18:00:00.000Z') };
const replyAction = { domain: 'conversation', action: 'reply', content: '¡Hola! 👋' };
const reminderAction = {
  domain: 'reminder', action: 'create', content: 'Llamar a Pedro', requiresConfirmation: false,
  schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 17, minute: 0, clockMode: 'explicit_24h' },
};

// Model fixtures include every provider-required field, including nested nulls.
function withNullPlaceholders(value, schema = TURN_INTENT_SCHEMA) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => withNullPlaceholders(item, schema.items));
  if (schema.properties && value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [
      // Canonical optionality is not producer nullability: this one additive
      // root field is a complete proposal decision, [] when nothing qualifies.
      key, Object.hasOwn(value, key) ? withNullPlaceholders(value[key], child) : (key === 'learningCandidates' ? [] : null),
    ]));
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(result, key)) {
        result[key] = value[key];
      }
    }
    return result;
  }
  return value;
}

function providerResponse(message) {
  return new Response(JSON.stringify({
    provider: 'Groq', choices: [{ finish_reason: 'stop', message }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function structuredResponse(intent) {
  const providerIntent = {
    ...intent,
    learningCandidates: Object.hasOwn(intent, 'learningCandidates') ? intent.learningCandidates : [],
    responseLanguage: Object.hasOwn(intent, 'responseLanguage') ? intent.responseLanguage : 'es',
    responseCapability: Object.hasOwn(intent, 'responseCapability') ? intent.responseCapability : 'general',
    actions: intent.actions.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const { domain, action, ...fields } = item;
      const operation = `${domain}.${action}`;
      return { operation, ...fields };
    }),
  };
  return providerResponse({
    role: 'assistant',
    content: JSON.stringify(withNullPlaceholders(providerIntent, getStructuredTurnSchema())),
  });
}

function expectStrictSchema(node, canonical, nullable = false) {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  expect(types).toEqual(nullable ? [canonical.type, 'null'] : [canonical.type]);
  expect(node).not.toHaveProperty('uniqueItems');
  // Descriptor coverage and the exact allowed differences from 1290e81 are
  // checked independently in provider-description-compaction.test.js.
  for (const key of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    expect(node[key]).toEqual(canonical[key]);
  }
  if (canonical.enum) expect(node.enum).toEqual(nullable ? [...canonical.enum, null] : canonical.enum);
  if (canonical.properties) {
    expect(node.additionalProperties).toBe(false);
    expect(Object.keys(node.properties)).toEqual(Object.keys(canonical.properties));
    expect(node.required).toEqual(Object.keys(canonical.properties));
    for (const [key, child] of Object.entries(canonical.properties)) {
      expectStrictSchema(node.properties[key], child, !(canonical.required || []).includes(key));
    }
  }
  if (canonical.items) expectStrictSchema(node.items, canonical.items);
}

describe('canonical uniqueness after Groq schema adaptation', () => {
  it('accepts a typed partial action from its missing fields without requiring a second schema action', () => {
    const partial = {
      domain: 'reminder', action: 'create', content: 'Pagar factura',
      schedule: { kind: 'relative_day_time', dayOffset: 1 }, missingFields: ['time'],
    };

    expect(validateTurnIntent({ actions: [partial] })).toMatchObject({ valid: true });
    expect(validateTurnIntent({ actions: [
      partial,
      { domain: 'clarification', action: 'request', question: 'Falta un dato', missingFields: ['time'] },
    ] })).toMatchObject({ valid: true });
  });


  it.each([
    { missingFields: [] },
    { missingFields: ['main_time'] },
    { missingFields: ['advance_minutes'] },
    { missingFields: ['main_time', 'advance_minutes'] },
    { missingFields: ['advance_minutes', 'main_time'] },
  ])('preserves valid missingFields without rewriting their order: %j', ({ missingFields }) => {
    const intent = { actions: [{ domain: 'clarification', action: 'request', missingFields }] };
    const snapshot = structuredClone(intent);

    const result = validateTurnIntent(intent);

    expect(result.valid).toBe(true);
    expect(result.intent.actions[0].missingFields).toEqual(missingFields);
    expect(intent).toEqual(snapshot);
    expect(TURN_INTENT_SCHEMA.properties.actions.items.properties.missingFields.uniqueItems).toBe(true);
  });

  it.each(['main_time', 'advance_minutes'])('rejects duplicated %s before exposing an executable intent', (field) => {
    const intent = { actions: [
      reminderAction,
      { domain: 'clarification', action: 'request', missingFields: [field, field] },
    ] };
    const snapshot = structuredClone(intent);

    const result = validateTurnIntent(intent);

    expect(result).toMatchObject({ valid: false, errorCode: 'INVALID_PARAMETERS' });
    expect(result).not.toHaveProperty('intent');
    expect(intent).toEqual(snapshot);
    expect(TURN_INTENT_SCHEMA).toEqual(canonicalSnapshot);
  });
});

describe('reminder delivery policy contract', () => {
  it('represents removal of advance delivery as canonical reminder state', () => {
    const result = validateTurnIntent({
      actions: [{
        domain: 'reminder',
        action: 'update',
        target: 'Mandar a recargar el extintor',
        deliveryPolicy: { advanceNotice: 'none' },
      }],
    });

    expect(result).toMatchObject({
      valid: true,
      intent: {
        actions: [{
          domain: 'reminder',
          action: 'update',
          target: 'Mandar a recargar el extintor',
          deliveryPolicy: { advanceNotice: 'none' },
        }],
      },
    });
  });

  it('requires an explicit offset when advance delivery is desired', () => {
    expect(validateTurnIntent({
      actions: [{
        domain: 'reminder',
        action: 'update',
        target: 'Cita',
        deliveryPolicy: { advanceNotice: 'offset' },
      }],
    })).toMatchObject({ valid: false, errorCode: 'INVALID_PARAMETERS' });
  });
});

describe('foreground strict Structured Outputs boundary', () => {
  let fetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    isAdminUser.mockReturnValue(false);
    clearWorkingMemory(user);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.spyOn(globalThis, 'fetch');
    executeTool.mockResolvedValue({
      success: true, complete: true, action: 'created_reminder',
      confirmation: '🔔 Recordatorio creado.', rawSummary: '🔔 Recordatorio creado.',
      data: { reminder: { id: 'r-structured', content: 'Llamar a Pedro', send_at: '2026-09-10T22:00:00.000Z' } },
    });
  });

  afterEach(() => {
    expect(TURN_INTENT_SCHEMA).toEqual(canonicalSnapshot);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('sends the actual foreground HTTP request as strict JSON Schema on Groq, without tool calling', async () => {
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [replyAction] }));

    const result = await routeMessage('Hola hola', user, [], turnOptions);

    expect(result.intent).toBe('chat');
    expect(result.confirmation).toBe(replyAction.content);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('openai/gpt-oss-120b');
    expect(payload.stream).toBe(false);
    expect(payload.max_tokens).toBe(8192);
    expect(payload.response_format.type).toBe('json_schema');
    expect(payload.response_format.json_schema.name).toBe('hermes_turn_intent');
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload.provider).toEqual({ order: ['groq'], only: ['groq'], allow_fallbacks: false, require_parameters: true });
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
    expect(executeTool).not.toHaveBeenCalled();

    const prompt = payload.messages[0].content;
    expect(prompt).toContain(EXECUTE_TURN_DESCRIPTION);
    expect(prompt).toContain('TurnIntent JSON');
    expect(prompt).toContain('deben ser null cuando no apliquen');
    expect(prompt).toContain(TURN_LANGUAGE_POLICY);
    expect(prompt).not.toContain('execute_turn');
    expect(prompt).not.toContain('This tool is mandatory');

    // Compare real serialized production transport bodies, differing solely in
    // the response schema from the immutable pre-compaction pure projection.
    const baselineSource = execFileSync('git', ['show', '1290e81:src/agent/contracts/foreground-turn-schema.js'], { encoding: 'utf8' });
    const baselineProjection = new Function('TURN_INTENT_SCHEMA', 'getCanonicalOperations', 'parseCanonicalOperation',
      baselineSource.replace(/^import \{[\s\S]*?\} from .*?;\n/, '').replaceAll('export function ', 'function ')
        + '\nreturn getStructuredTurnSchema;')(TURN_INTENT_SCHEMA, getCanonicalOperations, parseCanonicalOperation);
    const baselinePayload = structuredClone(payload);
    baselinePayload.response_format.json_schema.schema = baselineProjection();
    const currentBody = fetchMock.mock.calls[0][1].body;
    expect(Buffer.byteLength(JSON.stringify(baselinePayload)) - Buffer.byteLength(currentBody)).toBeGreaterThanOrEqual(1200);
    expect(payload.messages).toEqual(baselinePayload.messages);
  });

  it('marks prior chat as reference-only so stale assistant claims cannot become live-state operands', async () => {
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [replyAction] }));

    const history = [
      { role: 'user', content: '¿Cuánto debo?' },
      { role: 'assistant', content: 'Debes 580.000 pesos.' },
    ];
    await routeMessage('¿Cuánto me queda por pagar?', user, history, turnOptions);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.messages[1]).toEqual({
      role: 'system',
      content: expect.stringContaining('No es fuente de estado vivo ni de operandos para cálculos'),
    });
    expect(payload.messages[2]).toEqual(history[0]);
    expect(payload.messages[3]).toEqual({
      role: 'assistant',
      content: expect.stringContaining('SALIDA HISTÓRICA DE HERMES'),
    });
    expect(payload.messages[3].content).toContain('NO es evidencia de estado vivo ni insumo para cálculos');
    expect(payload.messages[3].content).toContain(history[1].content);
    expect(payload.messages.at(-1)).toMatchObject({ role: 'user', content: '¿Cuánto me queda por pagar?' });
  });

  it.each([false, true])('adapts every nested optional field without mutating the canonical schema (admin=%s)', async (isAdmin) => {
    isAdminUser.mockReturnValue(isAdmin);
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [replyAction] }));

    await routeMessage('Hola hola', user, [], turnOptions);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const expectedCanonical = structuredClone(canonicalSnapshot);
    expectedCanonical.required.push('responseLanguage', 'responseCapability', 'learningCandidates');
    expectedCanonical.properties.learningCandidates.description = 'CURRENT user ONLY: all useful durable facts, 0–3 usual; [] NEVER null. No assistant/history/attachments. Exact contiguous quote≠sufficient: full-turn quotes/denial/correction/attribution. No tasks/appointments/transient actions/debts/balances/greetings/temporary states; keep mixed facts with memory.save. Atomic compact Spanish. Lasting language/style yes, utterance/one-turn no; denial≠opposite. Changed reuse topicKey; unchanged omit. New stable value-independent keys: self identity/residence/work profile/<aspect>; lasting preference preference/<aspect>; else <entity_type>/<slug>/<aspect>. Clean canonical hints optional; pet≠physical write. Node independently admits. English always + status: profileUpdate={sourceQuote:"English always",language:en}, learningCandidates=[{topicKey:preference/language,category:preference,content:"Prefiere inglés.",evidence:"English always"}], task.list(status=all). Quoted/one-turn: profileUpdate=null; learningCandidates=[]; read.';
    const providerSchema = payload.response_format.json_schema.schema;
    const action = expectedCanonical.properties.actions.items;
    const domains = action.properties.domain.enum.filter((domain) => isAdmin || domain !== 'admin');
    delete action.properties.domain;
    delete action.properties.action;
    action.properties = {
      operation: {
        type: 'string',
        enum: getCanonicalOperations({ domains }),
        description: 'Exact qualified canonical operation. Domain/action are inseparable. A request for current operational content or status requires the matching live read (for example task.list), never conversation.reply.',
      },
      ...action.properties,
    };
    action.required = ['operation'];
    // Provider composition changes only: canonical prerequisites remain checked
    // by validateTurnIntent before any domain action, including missing schedules.
    expectedCanonical.properties.actions.items.properties.schedule.description += ' A complete reminder.create needs a usable schedule. If part is missing, keep known components on the partial action, declare missingFields and put the clarification question on that action; at most one clarification.request may accompany the incomplete draft. Each action retains its own known date/time components.';
    expectedCanonical.properties.actions.items.properties.schedule.properties.dayOffset.description = 'Number of local calendar days from the current message date: 0=today, 1=tomorrow, 2=day after tomorrow. When a day is shared by multiple requests, repeat that dayOffset in every applicable schedule; never reset it to 0 merely because the day appears in a preceding clause.';
    expectedCanonical.properties.actions.items.properties.schedule.properties.offsetMinutes.description = 'Duration from now, only for relative_offset. For every other kind use null. Do not compute a duration instead of preserving the requested calendar day and clock time.';
    for (const field of ['schedule', 'endSchedule']) {
      expectedCanonical.properties.actions.items.properties[field].properties.clockMode = {
        type: 'string', enum: ['explicit_24h', 'ambiguous_12h'],
        description: 'For an explicit AM/PM or 24h time, output hour 0..23 and explicit_24h (3 PM = 15, noon = 12, midnight = 0). For a genuinely ambiguous 12h time keep hour 1..12 and ambiguous_12h. Do not invent AM/PM.',
      };
    }
    const fields = expectedCanonical.properties.actions.items.properties;
    fields.endSchedule = structuredClone(fields.endSchedule);
    fields.endSchedule.description = 'End time; use the same temporal field semantics as schedule.';
    for (const field of ['kind', 'allDay', 'clockMode']) fields.endSchedule.properties[field].description = `Same semantics as schedule.${field}.`;
    expectStrictSchema(providerSchema, expectedCanonical);
    expect(validateTurnIntent).toHaveBeenCalledWith({ responseLanguage: 'es', responseCapability: 'general', learningCandidates: [], actions: [replyAction] }, { isAdmin, requireResponseCapability: true });
    expect(TURN_INTENT_SCHEMA.required).toEqual(['actions']);
    expect(TURN_INTENT_SCHEMA.properties.actions.items.required).toEqual(['domain', 'action']);
    expect(TURN_INTENT_SCHEMA.properties.actions.items.properties.schedule.required).toEqual(['kind']);
  });

  it('strips top-level and nested nullable placeholders before canonical validation, preserving zero and false', async () => {
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [reminderAction] }));

    const result = await routeMessage('Recuérdame llamar a Pedro mañana a las 5', user, [], turnOptions);

    expect(validateTurnIntent).toHaveBeenCalledTimes(2); // Provider admission, then router admission.
    expect(validateTurnIntent).toHaveBeenCalledWith({ responseLanguage: 'es', responseCapability: 'general', learningCandidates: [], actions: [reminderAction] }, { isAdmin: false, requireResponseCapability: true });
    expect(validateTurnIntent.mock.results[0].value.valid).toBe(true);
    expect(result.plan.type).toBe('turn_intent');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a provider partial reminder and stages an agent run for continuation', async () => {
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [{
      domain: 'reminder', action: 'create', content: 'Pagar factura',
      schedule: { kind: 'relative_day_time', dayOffset: 1 },
    }] }));

    const result = await routeMessage('Solicitud temporal incompleta', user, [], turnOptions);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.executionFacts).toHaveLength(1);
    expect(result.executionFacts[0]).toMatchObject({ requiresClarification: true });
    const run = await getActiveAgentRun(user, new Date(turnOptions.requestTimeMs));
    expect(run).toMatchObject({
      kind: 'reminder_creation',
      status: 'waiting_for_input',
    });
  });

  it('keeps operational focus distinct from Pending Intent across create, restart, add, and live read', async () => {
    const history = [];
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [
      { domain: 'entity', action: 'upsert', category: 'project' },
      ...['Sacar el pasaporte', 'Comprar bloqueador', 'Cargar la batería externa'].map((title) => ({
        domain: 'task', action: 'create', title, entityName: 'Viaje', category: 'project',
      })),
    ] }));
    executeTool
      .mockResolvedValueOnce({
        success: true, complete: true, action: 'upserted_entity', confirmation: 'Proyecto listo.',
        data: { id: 'project-viaje', name: 'Viaje', category: 'project' },
      })
      .mockResolvedValueOnce({
        success: true, complete: true, action: 'created_tasks_batch', confirmation: 'Tareas creadas.',
        data: ['Sacar el pasaporte', 'Comprar bloqueador', 'Cargar la batería externa'].map((title, index) => ({
          id: `task-${index + 1}`, title, entityId: 'project-viaje', entityName: 'Viaje',
        })),
      });

    const first = await routeMessage(
      'Crea pendientes del viaje con sacar el pasaporte, comprar bloqueador y cargar la batería externa.',
      user,
      history,
      turnOptions,
    );

    expect(first.executionFacts).toHaveLength(2);
    expect(first.executionFacts.every((fact) => fact.success)).toBe(true);
    expect(first.entities._conversationState.pendingIntent).toBeNull();
    expect(first.entities._conversationState.pendingClarifications).toEqual([]);
    expect(first.entities._workingMemory).toMatchObject({ activeEntity: 'Viaje' });
    expect(first.plan.actions.map(({ domain, action }) => `${domain}.${action}`)).toEqual([
      'entity.upsert', 'task.create', 'task.create', 'task.create',
    ]);
    history.push(
      { role: 'user', content: 'Crear colección operativa' },
      { role: 'assistant', content: first.confirmation, entities: first.entities, createdAt: new Date().toISOString() },
    );

    clearWorkingMemory(user);
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [
      { domain: 'task', action: 'create', title: 'Revisar el seguro de viaje', entityName: 'Viaje', category: 'project' },
    ] }));
    executeTool.mockResolvedValueOnce({
      success: true, complete: true, action: 'created_task', confirmation: 'Tarea creada.',
      data: [{ id: 'task-4', title: 'Revisar el seguro de viaje', entityId: 'project-viaje', entityName: 'Viaje' }],
    });

    const second = await routeMessage('Agrega también revisar el seguro de viaje.', user, history, turnOptions);

    expect(second.executionFacts).toHaveLength(1);
    expect(second.executionFacts[0].success).toBe(true);
    expect(second.entities._conversationState.pendingIntent).toBeNull();
    expect(executeTool.mock.calls[2][0].params).toEqual({
      action: 'create',
      items: [{ title: 'Revisar el seguro de viaje', entityName: 'Viaje', entityCategory: 'project' }],
    });
    const secondSchema = JSON.parse(fetchMock.mock.calls[1][1].body).response_format.json_schema.schema;
    expect(secondSchema.properties).not.toHaveProperty('pendingIntentEffect');

    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [
      { domain: 'task', action: 'list', entityName: 'Viaje', status: 'pending' },
    ] }));
    executeTool.mockResolvedValueOnce({
      success: true, complete: true, action: 'listed_tasks', confirmation: 'Estas son tus tareas.',
      data: ['Sacar el pasaporte', 'Comprar bloqueador', 'Cargar la batería externa', 'Revisar el seguro de viaje']
        .map((title, index) => ({ id: `task-${index + 1}`, title, entityId: 'project-viaje', entityName: 'Viaje' })),
    });

    const third = await routeMessage('¿Qué me falta del viaje?', user, [], turnOptions);

    expect(third.plan.actions).toEqual([{ domain: 'task', action: 'list' }]);
    expect(executeTool.mock.calls[3][0]).toMatchObject({
      toolName: 'manage_task', params: { action: 'list', entityName: 'Viaje', status: 'pending' },
    });
    expect(third.entities._workingMemory.items).toHaveLength(4);
  });

  it('rejects legacy pendingIntentEffect and unknown properties at the provider boundary', async () => {
    fetchMock.mockImplementation(async () => structuredResponse({
      pendingIntentEffect: 'resolve',
      actions: [reminderAction],
    }));

    const result = await routeMessage('Recuérdame llamar a Pedro mañana a las 5', user, [], turnOptions);

    expect(result.plan.type).toBe('invalid_structured_output');
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });


  it.each(['main_time', 'advance_minutes'])('rejects duplicate %s from structured content before executing any action in the turn', async (field) => {
    fetchMock.mockImplementation(async () => structuredResponse({ actions: [
      reminderAction,
      { domain: 'clarification', action: 'request', missingFields: [field, field] },
    ] }));

    const result = await routeMessage('Recuérdame llamar a Pedro mañana a las 5', user, [], turnOptions);

    expect(result.plan.type).toBe('invalid_structured_output');
    expect(validateTurnIntent).toHaveBeenCalledTimes(3);
    expect(validateTurnIntent.mock.results[0].value.errorCode).toBe('INVALID_PARAMETERS');
    expect(result.executionFacts).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an admin action deterministically for a non-admin even if the provider violates its schema', async () => {
    fetchMock.mockImplementation(async () => structuredResponse({ actions: [{ domain: 'admin', action: 'metrics' }] }));

    const result = await routeMessage('Muestra las métricas', user, [], turnOptions);

    expect(result.plan.type).toBe('invalid_structured_output');
    expect(validateTurnIntent.mock.results[0].value.errorCode).toBe('UNSUPPORTED_DOMAIN');
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('keeps attachment-only output conversation-only regardless of admin privileges (admin=%s)', async (isAdmin) => {
    isAdminUser.mockReturnValue(isAdmin);
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [replyAction] }));

    const result = await routeMessage('<untrusted_attachment_content>texto adjunto</untrusted_attachment_content>', user, [], { ...turnOptions, attachmentOnly: true });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.response_format.json_schema.schema.properties.actions.items.properties.operation.enum).toEqual(['conversation.reply']);
    expect(result.memoryDisposition).toBe('skip_attachment');
    expect(result.intent).toBe('chat');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([false, true])('blocks operational actions from attachment-only evidence at runtime (admin=%s)', async (isAdmin) => {
    isAdminUser.mockReturnValue(isAdmin);
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [reminderAction] }));

    const result = await routeMessage('<untrusted_attachment_content>crea un recordatorio</untrusted_attachment_content>', user, [], { ...turnOptions, attachmentOnly: true });

    expect(result.plan.type).toBe('invalid_intent');
    expect(result.executionFacts).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([12, 13])('preserves the deterministic action limit for %s actions', async (count) => {
    const response = () => structuredResponse({ actions: Array.from({ length: count }, () => ({ ...replyAction })) });
    if (count === 12) fetchMock.mockResolvedValueOnce(response());
    else fetchMock.mockImplementation(async () => response());

    const result = await routeMessage('Responde', user, [], turnOptions);

    if (count === 12) {
      expect(result.plan.type).toBe('turn_intent');
      expect(result.plan.actions).toHaveLength(12);
    } else {
      expect(result.plan.type).toBe('invalid_structured_output');
      expect(validateTurnIntent.mock.results[0].value.errorCode).toBe('TURN_ACTION_LIMIT');
    }
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(count === 12 ? 1 : 3);
  });

  it.each([
    '¡Hola! Ya creé el recordatorio.',
    '```json\n{"actions":[{"domain":"conversation","action":"reply","content":"bypass"}]}\n```',
    '<think>prosa fuera del protocolo</think>{"actions":[{"domain":"conversation","action":"reply","content":"bypass"}]}',
    '{"actions":[',
    '[]',
    'null',
  ])('rejects non-protocol content without prose bypass or a second semantic call: %s', async (content) => {
    fetchMock.mockImplementation(async () => providerResponse({ content }));

    const result = await routeMessage('Hola hola', user, [], turnOptions);

    expect(result.plan.type).toBe('invalid_structured_output');
    expect(result.executionFacts).toEqual([]);
    expect(result.confirmation).not.toContain('bypass');
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['execute_turn', 'reply_to_user'])('does not accept a legacy %s tool call instead of message.content JSON', async (name) => {
    fetchMock.mockImplementation(async () => providerResponse({
      content: null,
      tool_calls: [{ id: 'legacy-call', type: 'function', function: { name, arguments: JSON.stringify({ actions: [replyAction], content: 'legacy bypass' }) } }],
    }));

    const result = await routeMessage('Hola hola', user, [], turnOptions);

    expect(result.plan.type).toBe('invalid_structured_output');
    expect(result.confirmation).not.toContain('legacy bypass');
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ domain: 'reminder', action: 'update', content: 'Otro contenido' }, 'MISSING_TARGET'],
    [{ ...reminderAction, recurrence: 'unsupported' }, 'INVALID_RECURRENCE'],
    [{ domain: 'reminder', action: 'unsupported' }, 'UNSUPPORTED_ACTION'],
    [{ domain: null, action: 'reply', content: 'No autorizado' }, 'UNSUPPORTED_DOMAIN'],
    [null, 'INVALID_PARAMETERS'],
  ])('preserves canonical rejection of invalid actions after structural null removal: %j', async (action, errorCode) => {
    fetchMock.mockImplementation(async () => structuredResponse({ actions: [action] }));

    const result = await routeMessage('Hazlo', user, [], turnOptions);

    expect(result.plan.type).toBe('invalid_structured_output');
    expect(validateTurnIntent.mock.results[0].value.errorCode).toBe(errorCode);
    expect(result.executionFacts).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each([1, 3, 6, 12])('transports %s reminder schedules independently through nullable JSON to exact UTC tool arguments', async (count) => {
    const actions = Array.from({ length: count }, (_, index) => ({
      domain: 'reminder', action: 'create', content: `Solicitud ${index + 1}`,
      schedule: { kind: 'relative_day_time', dayOffset: index % 3 + 1, hour: index + 6, minute: index, clockMode: 'explicit_24h' },
    }));
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions }));
    executeTool.mockImplementation(async ({ params }) => ({ success: true, complete: true, action: 'created_reminder', data: { timezone: user.timezone, items: params.items.map((item, index) => ({ ...item, id: `created-${index}`, sendAt: item.targetTime })) } }));

    const result = await routeMessage('Varias solicitudes con sus propios horarios', user, [], turnOptions);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.plan.actions).toHaveLength(count);
    expect(result.executionFacts).toHaveLength(count);
    expect(executeTool).toHaveBeenCalledTimes(count);
    actions.forEach((action, index) => {
      const expected = new Date(Date.UTC(2026, 8, 9 + action.schedule.dayOffset, action.schedule.hour + 5, action.schedule.minute)).toISOString();
      expect(executeTool.mock.calls[index][0]).toMatchObject({ toolName: 'manage_reminder', params: { action: 'create', items: [{ content: action.content, targetTime: expected }] } });
    });
    expect(result.executionFacts.every((fact) => fact.success)).toBe(true);
  });

  it.each([null, {}, { kind: 'inherit_context' }])('rejects a malformed create schedule before executing the rest of the batch: %j', async (schedule) => {
    fetchMock.mockImplementation(async () => structuredResponse({ actions: [reminderAction, { ...reminderAction, schedule }] }));
    const result = await routeMessage('Dos recordatorios', user, [], turnOptions);
    expect(result.plan.type).toBe('invalid_structured_output');
    expect(result.executionFacts).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves two explicit hours and clarifies only the ambiguous request, then creates only the clarified item', async () => {
    // Synthetic equivalent of the incident, not customer data or reconstructed history.
    const actions = [
      { domain: 'reminder', action: 'create', content: 'Comprar billetes', schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 12, minute: 0, clockMode: 'explicit_pm' } },
      { domain: 'reminder', action: 'create', content: 'Pedir cita para el viernes', schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0, clockMode: 'explicit_am' } },
      { domain: 'clarification', action: 'request', content: 'Pedir cita para uñas', missingFields: ['main_time'], question: '¿Cuándo quieres el aviso para pedir la cita de uñas?' },
    ];
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions }));
    executeTool.mockImplementation(async ({ params }) => ({ success: true, complete: true, action: 'created_reminder', data: { timezone: user.timezone, items: params.items.map((item) => ({ id: item.content, content: item.content, sendAt: item.targetTime })) } }));
    const text = 'Mañana al mediodía recuérdame comprar billetes; a las nueve de la mañana pedir cita para el viernes; y recuérdame pedir cita para uñas.';
    const reference = { requestTimeMs: Date.parse('2026-09-10T00:08:07.000Z') };

    const first = await routeMessage(text, user, [], reference);

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[0][0].params.items[0].targetTime).toBe('2026-09-10T17:00:00.000Z');
    expect(executeTool.mock.calls[1][0].params.items[0].targetTime).toBe('2026-09-10T14:00:00.000Z');
    expect(first.executionFacts.map((fact) => fact.success)).toEqual([true, true, false]);
    expect(first.executionFacts[2].requiresClarification).toBe(true);
    expect(first.confirmation).toContain(actions[2].question);
    expect(first.confirmation).toContain('Comprar billetes');
    expect(first.confirmation).toContain('Pedir cita para el viernes');

    const finalAction = { domain: 'reminder', action: 'create', content: 'Pedir cita para uñas', schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 15, minute: 0, clockMode: 'explicit_24h' } };
    fetchMock.mockResolvedValueOnce(structuredResponse({ actions: [finalAction] }));
    const history = [{ role: 'user', content: text }, { role: 'assistant', content: first.confirmation, entities: first.entities }];
    const second = await routeMessage('El aviso de las uñas mañana a las 3 de la tarde', user, history, reference);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls[2][0].params.items).toEqual([{ content: 'Pedir cita para uñas', targetTime: '2026-09-10T20:00:00.000Z' }]);
    expect(second.executionFacts).toHaveLength(1);
  });

  it('never accepts legacy tool calls alongside otherwise valid structured JSON', async () => {
    const { domain, action, ...fields } = reminderAction;
    const wire = { responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: `${domain}.${action}`, ...fields }] };
    fetchMock.mockResolvedValueOnce(providerResponse({ content: JSON.stringify(withNullPlaceholders(wire, getStructuredTurnSchema())), tool_calls: [{ function: { name: 'execute_turn', arguments: '{}' } }] }));
    const result = await routeMessage('Recuérdame llamar', user, [], turnOptions);
    expect(result.plan.type).toBe('invalid_intent');
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
