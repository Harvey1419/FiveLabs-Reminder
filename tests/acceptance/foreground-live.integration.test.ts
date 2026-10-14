import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type SandboxItem = { title: string; content: string; targetTime: string; entityName: string };
type SandboxCall = { toolName: string; language?: string; params: { action: string; name: string; category: string; entityName: string; target: string; filter: string; scope: string; items: SandboxItem[] } };
type SandboxMock = Mock<(call: SandboxCall) => Promise<unknown>>;
type ProviderReply = { provider?: unknown; id?: unknown; error?: { metadata?: { error_type?: unknown }; type?: unknown }; choices?: { finish_reason?: string; error?: { metadata?: { error_type?: unknown }; type?: unknown }; message?: { content?: string; tool_calls?: unknown[] } }[]; usage?: { completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } };
type ProviderPayload = { model: string; provider?: { only?: string[] } };
type RouteView = { confirmation: string; intent?: string; language?: string; entities?: Record<string, unknown>; plan: { actions: { domain: string; action: string }[] }; executionFacts: { success?: boolean; requiresClarification?: boolean; errorCode?: string }[] };

// Real provider, real prompt, real schema, real canonical validation and real
// orchestration. Only database reads and domain side effects are isolated.
// Never run this with a customer account or substitute another provider on failure.
vi.mock('../../src/agent/providers/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/providers/client.js')>();
  return { ...actual, callChatCompletion: (messages: Parameters<typeof actual.callChatCompletion>[0], options: Parameters<typeof actual.callChatCompletion>[1]) => actual.callChatCompletion(messages, {
    ...options, startStage: process.env.FOREGROUND_ACCEPTANCE_STAGE || 'primary',
  } as Parameters<typeof actual.callChatCompletion>[1]) };
});
vi.mock('../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })) }));
vi.mock('../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/infrastructure/database/index.js', () => ({
  supabase: null,
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));
vi.mock('../../src/shared/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/auth.js')>();
  return { ...actual, isAdminUser: vi.fn(() => false) };
});
vi.mock('../../src/agent/contracts/intent-contracts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/contracts/intent-contracts.js')>();
  return { ...actual, validateTurnIntent: vi.fn(actual.validateTurnIntent) };
});

import { routeMessage } from '../../src/agent/orchestration/router.js';
import { executeTool } from '../../src/agent/tools/index.js';
import { clearWorkingMemory } from '../../src/agent/core/working-memory.js';
import { getActiveAgentRun, createInputRun, createApprovalRun } from '../../src/agent/core/agent-run.js';
import { updateUserPreferences } from '../../src/infrastructure/database/users.js';
import { clearAgentRunsForUser } from '../../src/infrastructure/database/agent-runs.js';
import { isAdminUser } from '../../src/shared/auth.js';

const stage = process.env.FOREGROUND_ACCEPTANCE_STAGE || 'primary';
const domainActionFocus = process.env.FOREGROUND_ACCEPTANCE_FOCUS === 'domain-action';
const extendedIt = domainActionFocus ? it.skip : it;
const routes: Record<string, [string, string]> = {
  primary: ['openai/gpt-oss-120b', 'groq'],
  secondary: ['openai/gpt-oss-120b', 'cerebras/fp16'],
  last_resort: ['z-ai/glm-5.3-flash', 'baseten/fp8'],
};
const [model, provider] = routes[stage] || [];
const routeOrder = ['primary', 'secondary', 'last_resort'];
const allowedRoutes = routeOrder.slice(routeOrder.indexOf(stage)).map((name) => routes[name]!);
// Domain-action acceptance remains available for deliberate manual runs, but
// is not part of the provider smoke gate. Live provider output is inherently
// nondeterministic; deterministic action invariants belong in offline tests.
const liveActionDescribe = process.env.FOREGROUND_ACCEPTANCE_RUN_ACTIONS === '1' ? describe : describe.skip;
const realFetch = globalThis.fetch.bind(globalThis);
const user = { id: 'synthetic-acceptance', phone_number: '573000000001', timezone: 'America/Bogota', locale: 'es-CO' };
const reference = { requestTimeMs: Date.parse('2026-09-10T00:08:07.000Z') };
const summary: Record<string, unknown>[] = [];
const safeMetadata = (value: unknown) => typeof value === 'string'
  ? value.split(process.env.OPENROUTER_API_KEY || '__no_key__').join('[REDACTED]').slice(0, 160)
  : typeof value === 'number' && Number.isFinite(value) ? value : null;
let attempts: ProviderPayload[];
let responses: (ProviderReply | null)[];
let caseName: string;
let totalAttempts = 0;

beforeAll(() => {
  if (!model || !process.env.OPENROUTER_API_KEY?.trim()) throw new Error('Live acceptance requires a known stage and OPENROUTER_API_KEY; missing credentials are NOT a pass.');
});
beforeEach((context) => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearWorkingMemory(user);
  clearAgentRunsForUser(user);
  (isAdminUser as Mock<typeof isAdminUser>).mockReturnValue(false);
  attempts = [];
  responses = [];
  caseName = context.task.name;
  (executeTool as unknown as SandboxMock).mockImplementation(async ({ toolName, params }) => {
    if (toolName === 'manage_entity' && ['create', 'upsert'].includes(params.action)) {
      return { success: true, complete: true, action: 'created_entity', data: { id: 'synthetic-project', name: params.name, category: params.category } };
    }
    if (toolName === 'manage_task' && params.action === 'create') {
      return {
        success: true,
        complete: true,
        action: 'created_tasks_batch',
        data: params.items.map((item, index) => ({
          id: `synthetic-task-${index + 1}`,
          title: item.title,
          entityId: 'synthetic-project',
          entityName: item.entityName,
        })),
      };
    }
    if (toolName === 'manage_task' && params.action === 'list') {
      const entityName = params.entityName || 'Cosas para el viaje';
      const tasks = ['Pasaporte', 'Cargador', 'Bloqueador'].map((title, index) => ({
        id: `synthetic-task-${index + 1}`, title, status: 'pending', entityName,
      }));
      return { success: true, complete: true, action: 'listed_tasks', data: { tasks, items: tasks, entityName } };
    }
    if (toolName === 'manage_task' && ['complete', 'delete'].includes(params.action)) {
      return { success: true, complete: true, action: `${params.action}d_task`, data: { id: 'synthetic-task-1', title: params.target, entityName: params.entityName || 'Cosas para el viaje' } };
    }
    if (toolName !== 'manage_reminder') throw new Error('Acceptance sandbox blocks unrelated tools.');
    if (params.action === 'create') {
      return { success: true, complete: true, action: 'created_reminder', data: { timezone: user.timezone, items: params.items.map((item) => ({ id: `synthetic-${item.content}`, content: item.content, sendAt: item.targetTime })) } };
    }
    if (params.action === 'list') {
      const reminders = [
        { id: 'synthetic-alpha', content: 'Revisar Alfa', send_at: '2026-09-10T15:00:00.000Z' },
        { id: 'synthetic-beta', content: 'Revisar Beta', send_at: '2026-09-10T18:00:00.000Z' },
        { id: 'synthetic-gamma', content: 'Revisar Gamma', send_at: '2026-09-10T21:00:00.000Z' },
      ];
      return { success: true, complete: true, action: 'listed_reminders', data: { reminders, items: reminders, filter: params.filter, timezone: user.timezone, locale: user.locale } };
    }
    if (params.action === 'cancel') {
      return { success: true, complete: true, action: 'cancelled_reminder', data: { id: params.target, content: params.target } };
    }
    throw new Error(`Acceptance sandbox blocks reminder.${params.action}.`);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (++totalAttempts > Number(process.env.FOREGROUND_ACCEPTANCE_MAX_REQUESTS || 20)) throw new Error('Acceptance request budget exhausted.');
    const payload = JSON.parse(init!.body as string);
    attempts.push(payload);
    // Fail closed BEFORE network I/O: the selected route and only its explicit
    // compatible successors are allowed. This exercises the real fallback
    // chain without enabling OpenRouter's implicit provider routing.
    const requestedRoute = allowedRoutes.find(([allowedModel, allowedProvider]) => (
      payload.model === allowedModel
      && JSON.stringify(payload.provider?.only) === JSON.stringify([allowedProvider])
    ));
    if (url !== 'https://openrouter.ai/api/v1/chat/completions' || !requestedRoute) {
      throw new Error('Acceptance blocked an independent fallback or unrelated network call.');
    }
    expect(payload.provider).toEqual({ order: [requestedRoute[1]], only: [requestedRoute[1]], allow_fallbacks: false, require_parameters: true });
    expect(payload.response_format.type).toBe('json_schema');
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
    const started = Date.now();
    const res = await realFetch(url, init);
    const data = await res.clone().json().catch(() => null) as ProviderReply | null;
    responses.push(data);
    const choice = data?.choices?.[0];
    const error = data?.error || choice?.error;
    // Report only reproducible protocol metadata. No key, prompts, content or reasoning.
    summary.push({ case: caseName, stage, requestedModel: payload.model, requestedProvider: requestedRoute[1],
      reportedProvider: safeMetadata(data?.provider), generationId: safeMetadata(data?.id),
      httpStatus: res.status, finishReason: safeMetadata(choice?.finish_reason),
      errorType: safeMetadata(error?.metadata?.error_type ?? error?.type),
      completionTokens: safeMetadata(data?.usage?.completion_tokens),
      reasoningTokens: safeMetadata(data?.usage?.completion_tokens_details?.reasoning_tokens),
      latencyMs: Date.now() - started });
    return res;
  });
});
afterEach(async (context) => {
  const warnings = (console.warn as Mock<typeof console.warn>).mock.calls.map((args) => args.join(' '));
  const execution = (console.log as Mock<typeof console.log>).mock.calls.map((args) => args.join(' ')).slice(-12);
  vi.restoreAllMocks();
  if (context.task.result?.state === 'fail') {
    const decisions = responses.map((response) => {
      try {
        const parsed = JSON.parse(response?.choices?.[0]?.message?.content!) as { responseLanguage?: unknown; profileUpdate?: unknown; actions?: { operation?: unknown; schedule?: unknown }[] };
        return {
          responseLanguage: parsed.responseLanguage,
          profileUpdate: parsed.profileUpdate,
          actions: parsed.actions?.map(({ operation, schedule }) => ({ operation, schedule })),
        };
      } catch { return null; }
    });
    console.log('ACCEPTANCE_FAILURE ' + JSON.stringify({ case: caseName, warnings: warnings.slice(-5), execution, decisions }));
  }
  if (domainActionFocus) await new Promise((resolve) => setTimeout(resolve, 4000));
});
afterAll(() => writeFileSync(process.env.FOREGROUND_ACCEPTANCE_REPORT || `foreground-acceptance-${stage}.json`, JSON.stringify(summary, null, 2)));

function assertCompleteDecision(count = 1) {
  const accepted = (console.log as Mock<typeof console.log>).mock.calls
    .map((args) => args.join(' '))
    .filter((line) => line.includes('attempt purpose=initial') && line.includes('outcome=success'));
  expect(accepted).toHaveLength(count);
  for (const data of responses.filter((item) => !item?.error && item?.choices?.[0]?.finish_reason === 'stop')) {
    expect(data?.choices?.[0]?.message?.tool_calls || []).toEqual([]);
  }
}
function assertReminder(index: number, subject: string, at: string) {
  const item = (executeTool as unknown as SandboxMock).mock.calls[index]?.[0]?.params?.items?.[0];
  expect(item?.content.toLowerCase()).toContain(subject.toLowerCase());
  expect(item?.targetTime).toBe(at);
}
function assertReminderExists(subject: string, at: string, calls = (executeTool as unknown as SandboxMock).mock.calls) {
  const item = calls
    .map((call) => call?.[0]?.params?.items?.[0])
    .find((candidate) => candidate?.content?.toLowerCase().includes(subject.toLowerCase()));
  expect(item?.targetTime).toBe(at);
}
const tomorrow = (hour: number) => new Date(Date.UTC(2026, 8, 10, hour + 5, 0)).toISOString();

// Subjects are synthetic labels. Assertions compare known expected structures;
// no model judges another model and no production code parses these phrases.
describe(`live strict foreground acceptance: ${stage}`, () => {
  it('Hola hola', async () => {
    const result = await routeMessage('Hola hola', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(result.intent).toBe('chat');
    expect(result.confirmation.length).toBeGreaterThan(0);
    expect(executeTool).not.toHaveBeenCalled();
  });

  extendedIt('accepts the admin schema without using the administrative domain for a greeting', async () => {
    (isAdminUser as Mock<typeof isAdminUser>).mockReturnValue(true);
    const result = await routeMessage('Hola hola', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(result.intent).toBe('chat');
    expect(executeTool).not.toHaveBeenCalled();
  });

  liveActionDescribe('live domain-action acceptance (opt-in)', () => {
  it('core production: answers a derived total from the tool inventory', async () => {
    (executeTool as unknown as SandboxMock).mockImplementation(async ({ toolName, params }) => {
      expect(toolName).toBe('manage_task');
      expect(params.action).toBe('list');
      const tasks = [{ id: 'quota-alpha', title: 'Cuota Alfa: 120 pesos', status: 'pending' }, { id: 'quota-beta', title: 'Cuota Beta: 80 pesos', status: 'pending' }];
      return { success: true, complete: true, action: 'listed_tasks', data: { tasks, items: tasks, entityName: 'Apartamento' } };
    });
    const result = await routeMessage('¿Cuánto suman los importes de las cuotas pendientes del proyecto Apartamento? Lee las tareas actuales y calcula el total.', user, [], reference) as unknown as RouteView;
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.confirmation).toContain('200');
    expect(result.executionFacts.every(fact => fact.success)).toBe(true);
  });

  it('core production: preserves a shared future date, separate times and English response', async () => {
    const result = await routeMessage('Set two reminders for next Tuesday to review the inspection, one at 7am and another at 4pm.', user, [], { requestTimeMs: Date.parse('2026-10-02T14:00:00Z') }) as unknown as RouteView;
    expect(result.language).toBe('en');
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect((executeTool as unknown as SandboxMock).mock.calls.map(([call]) => call.params.items[0]!.targetTime).sort()).toEqual(['2026-10-06T12:00:00.000Z', '2026-10-06T21:00:00.000Z']);
    expect(result.executionFacts.every(fact => fact.success)).toBe(true);
  });

  it('core production: an approval correction replaces the old proposal', async () => {
    await createApprovalRun({ user, referenceTime: new Date(reference.requestTimeMs), kind: 'reminder_creation', preparedActions: [{
      callId: 'call-1', domain: 'reminder', action: 'create', targetName: 'Review the inspection',
      payload: { action: 'create', items: [{ content: 'Review the inspection', targetTime: '2026-09-10T12:00:00.000Z' }] },
    }], question: 'Did you mean tomorrow at 7am?' });
    const result = await routeMessage('No, replace that: remind me to review the inspection next Tuesday at 4pm instead.', user, [], reference) as unknown as RouteView;
    expect(result.language).toBe('en');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect((executeTool as unknown as SandboxMock).mock.calls[0]![0]!.params.items[0]!.targetTime).toBe('2026-09-15T21:00:00.000Z');
  });

  it('core production: completes different pending clocks by exact action identity', async () => {
    await createInputRun({ user, referenceTime: new Date(reference.requestTimeMs), timezone: user.timezone, partialActions: ['Inspect Alpha', 'Inspect Beta'].map(content => ({
      domain: 'reminder', action: 'create', content, schedule: { kind: 'relative_day_time', dayOffset: 1 }, missingFields: ['time'],
    })), missingFields: ['time'], question: 'At what times?' });
    const result = await routeMessage('Alpha at 7am and Beta at 4pm.', user, [], reference) as unknown as RouteView;
    expect(result.language).toBe('en');
    expect(executeTool).toHaveBeenCalledTimes(2);
    assertReminderExists('Alpha', '2026-09-10T12:00:00.000Z');
    assertReminderExists('Beta', '2026-09-10T21:00:00.000Z');
  });

  it('core production: current language outranks quoted Spanish without changing profile', async () => {
    const current = 'Please remind me to review the report in thirty minutes.';
    const result = await routeMessage(`<untrusted_quoted_message>Háblame siempre en español.</untrusted_quoted_message>${current}`, user, [], { ...reference, currentUserText: current }) as unknown as RouteView;
    expect(result.language).toBe('en');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect((executeTool as unknown as SandboxMock).mock.calls[0]![0]!.language).toBe('en');
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });

  it('core production: explicit residence outranks an unrelated travel destination', async () => {
    const result = await routeMessage('Mi zona horaria es America/Bogota. Recuérdame comprar el vuelo a Madrid mañana a las 10 de la mañana.', { ...user, timezone: 'America/New_York' }, [], reference) as unknown as RouteView;
    expect(updateUserPreferences).toHaveBeenCalledWith(user.id, { timezone: 'America/Bogota' });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect((executeTool as unknown as SandboxMock).mock.calls[0]![0]!.params.items[0]!.targetTime).toBe('2026-09-10T15:00:00.000Z');
    expect(result.executionFacts.every(fact => fact.success)).toBe(true);
  });

  it('core production: discloses a failed write instead of confirming the planned operation', async () => {
    (executeTool as unknown as SandboxMock).mockResolvedValueOnce({ success: false, errorCode: 'DATABASE_ERROR', error: 'The reminder could not be saved.' });
    const result = await routeMessage('Please remind me to inspect Alpha in twenty minutes.', user, [], reference) as unknown as RouteView;
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.executionFacts[0]!.success).toBe(false);
    expect(result.confirmation).toContain('could not be saved');
  });

  it('keeps the original single-reminder smoke request executable', async () => {
    const result = await routeMessage('Recuérdame llamar a Pedro mañana a las 5 de la tarde', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(1);
    const item = (executeTool as unknown as SandboxMock).mock.calls[0]![0]!.params.items[0];
    expect(item!.content.toLowerCase()).toContain('pedro');
    expect(item!.targetTime).toBe('2026-09-10T22:00:00.000Z');
    expect(result.executionFacts.every((fact) => fact.success)).toBe(true);
  });

  it('creates several reminders without crossing domain/action boundaries', async () => {
    const result = await routeMessage('Mañana a las 9 de la mañana recuérdame revisar Alfa, a las 11 de la mañana revisar Beta y a las 3 de la tarde revisar Gamma; son tres recordatorios separados.', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(result.plan.actions).toEqual([
      { domain: 'reminder', action: 'create' },
      { domain: 'reminder', action: 'create' },
      { domain: 'reminder', action: 'create' },
    ]);
    expect(executeTool).toHaveBeenCalledTimes(3);
  });

  it('maps a today reminder inventory to reminder.list with the exact filter', async () => {
    const result = await routeMessage('¿Qué recordatorios tenemos para hoy?', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(result.plan.actions).toEqual([{ domain: 'reminder', action: 'list' }]);
    expect(executeTool).toHaveBeenCalledTimes(1);
    const call = (executeTool as unknown as SandboxMock).mock.calls[0]![0];
    expect(call).toMatchObject({ toolName: 'manage_reminder', params: { action: 'list' } });
    expect(call.params.filter === 'pending_today' || call.params.scope === 'today').toBe(true);
  });

  it('keeps plural contextual reminder deletion in the reminder domain', async () => {
    const first = await routeMessage('¿Qué recordatorios tenemos para hoy?', user, [], reference) as unknown as RouteView;
    const history = [
      { role: 'user', content: '¿Qué recordatorios tenemos para hoy?' },
      { role: 'assistant', content: first.confirmation, entities: first.entities },
    ];
    const second = await routeMessage('Elimina el primero y el tercero', user, history, reference) as unknown as RouteView;
    assertCompleteDecision(2);
    expect(second.plan.actions).toEqual([
      { domain: 'reminder', action: 'cancel' },
      { domain: 'reminder', action: 'cancel' },
    ]);
    const mutations = (executeTool as unknown as SandboxMock).mock.calls.map(([call]) => call).filter((call) => call.params.action === 'cancel');
    expect(mutations).toHaveLength(2);
    expect(mutations.map((call) => call.params.target)).toEqual(['synthetic-alpha', 'synthetic-gamma']);
  });

  it('represents and continues an operational collection as one project with task members', async () => {
    const created = await routeMessage('Crea pendientes del viaje con sacar el pasaporte, comprar bloqueador y cargar la batería externa.', user, [], reference) as unknown as RouteView;
    const createdActions = created.plan.actions.map(({ domain, action }) => `${domain}.${action}`);
    expect(createdActions.filter((action) => action === 'task.create')).toHaveLength(3);
    expect(createdActions.every((action) => (
      action === 'task.create' || ['entity.create', 'entity.upsert'].includes(action)
    ))).toBe(true);

    const createCalls = (executeTool as unknown as SandboxMock).mock.calls.map(([call]) => call);
    const entityCall = createCalls.find((call) => call.toolName === 'manage_entity');
    const taskCall = createCalls.find((call) => call.toolName === 'manage_task');
    if (entityCall) {
      expect(entityCall.params).toMatchObject({ category: 'project' });
      expect(['create', 'upsert']).toContain(entityCall.params.action);
    }
    expect(taskCall).toMatchObject({ toolName: 'manage_task', params: { action: 'create' } });
    expect(taskCall!.params.items).toHaveLength(3);
    const containerNames = new Set(taskCall!.params.items.map((item) => item.entityName));
    expect(containerNames.size).toBe(1);
    const [containerName] = [...containerNames];
    expect(containerName).toBeTruthy();
    if (entityCall) expect(entityCall.params.name).toBe(containerName);

    (executeTool as unknown as SandboxMock).mockClear();
    const added = await routeMessage('Agrega también revisar el seguro de viaje.', user, [], reference) as unknown as RouteView;
    expect(added.plan.actions).toEqual([{ domain: 'task', action: 'create' }]);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: expect.objectContaining({ action: 'create' }),
    }));
    expect((executeTool as unknown as SandboxMock).mock.calls[0]![0]!.params.items[0]!.entityName).toBe(containerName);

    (executeTool as unknown as SandboxMock).mockClear();
    const listed = await routeMessage('¿Qué me falta del viaje?', user, [], reference) as unknown as RouteView;
    expect(listed.plan.actions).toEqual([{ domain: 'task', action: 'list' }]);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: expect.objectContaining({ action: 'list', entityName: containerName }),
    }));

    (executeTool as unknown as SandboxMock).mockClear();
    const completed = await routeMessage('Marca la tarea sacar el pasaporte como completada.', user, [], reference) as unknown as RouteView;
    expect(completed.plan.actions).toEqual([{ domain: 'task', action: 'complete' }]);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: expect.objectContaining({ action: 'complete', target: expect.stringMatching(/pasaporte/i) }),
    }));
  });

  it('keeps a non-actionable collection of people in the entity domain', async () => {
    const result = await routeMessage('Registra a Ana y Luis como dos personas de mi equipo.', user, [], reference) as unknown as RouteView;
    expect(result.plan.actions).toHaveLength(2);
    expect(result.plan.actions.every(({ domain, action }) => domain === 'entity' && ['create', 'upsert'].includes(action))).toBe(true);
    expect((executeTool as unknown as SandboxMock).mock.calls.every(([call]) => call.toolName === 'manage_entity')).toBe(true);
  });

  extendedIt.each([1, 2, 3])('keeps three different reminder hours associated with their subjects, repetition %i', async () => {
    const text = 'Mañana al mediodía recuérdame revisar Alfa; también mañana a las 9 de la mañana revisar Beta; y el viernes a las 3 de la tarde revisar Gamma. Son tres recordatorios.';
    const result = await routeMessage(text, user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(result.executionFacts.every((fact) => fact.success)).toBe(true);
    assertReminderExists('Alfa', tomorrow(12));
    assertReminderExists('Beta', tomorrow(9));
    assertReminderExists('Gamma', '2026-09-11T20:00:00.000Z');
  });

  extendedIt('applies a shared time only to its stated requests', async () => {
    await routeMessage('Mañana a las 9 de la mañana recuérdame revisar Alfa y también revisar Beta. Quiero dos recordatorios a esa hora.', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(2);
    assertReminder(0, 'Alfa', tomorrow(9)); assertReminder(1, 'Beta', tomorrow(9));
  });

  extendedIt('replaces an explicitly corrected time without creating a duplicate', async () => {
    await routeMessage('Mañana a las 9 de la mañana, no, mejor a las 10 de la mañana, recuérdame revisar Alfa.', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(1);
    assertReminder(0, 'Alfa', tomorrow(10));
  });

  extendedIt('distinguishes the reminder time from the appointment date in its content', async () => {
    await routeMessage('Mañana a las 9 de la mañana recuérdame pedir la cita de Alfa para el viernes.', user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(1);
    assertReminder(0, 'Alfa', tomorrow(9));
    expect((executeTool as unknown as SandboxMock).mock.calls[0]![0]!.params.items[0]!.content.toLowerCase()).toContain('viernes');
  });

  it('preserves a partial reminder across an independent task and completes it exactly once', async () => {
    const text = 'Recuérdame mañana pagar el recibo.';
    const first = await routeMessage(text, user, [], reference) as unknown as RouteView;
    expect(executeTool).not.toHaveBeenCalled();
    expect(first.executionFacts).toHaveLength(1);
    expect(first.executionFacts[0]!.requiresClarification).toBe(true);
    const firstRun = await getActiveAgentRun(user, new Date(reference.requestTimeMs));
    expect(firstRun).not.toBeNull();
    expect(firstRun!.status).toBe('waiting_for_input');
    expect(firstRun!.kind).toBe('reminder_creation');

    const firstHistory = [{ role: 'user', content: text }, { role: 'assistant', content: first.confirmation, entities: first.entities }];
    const secondText = 'Antes de eso, crea una tarea para comprar bombillos.';
    const second = await routeMessage(secondText, user, firstHistory, reference) as unknown as RouteView;
    expect(second.plan.actions).toEqual([{ domain: 'task', action: 'create' }]);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect((executeTool as unknown as SandboxMock).mock.calls[0]![0]).toMatchObject({
      toolName: 'manage_task',
      params: { action: 'create', items: [{ title: expect.stringMatching(/bombillos/i) }] },
    });
    const secondRun = await getActiveAgentRun(user, new Date(reference.requestTimeMs));
    expect(secondRun).not.toBeNull();
    expect(secondRun!.status).toBe('waiting_for_input');

    const history = [
      ...firstHistory,
      { role: 'user', content: secondText },
      { role: 'assistant', content: second.confirmation, entities: second.entities },
    ];
    const third = await routeMessage('A las 9 de la mañana.', user, history, reference) as unknown as RouteView;
    assertCompleteDecision(3);
    expect(executeTool).toHaveBeenCalledTimes(2);
    assertReminder(1, 'recibo', tomorrow(9));
    const thirdRun = await getActiveAgentRun(user, new Date(reference.requestTimeMs));
    expect(thirdRun).toBeNull();
  });

  extendedIt('keeps one compound pending intent while three later clocks complete its three known contents', async () => {
    const text = 'Recuérdame mañana revisar Alfa, revisar Beta y revisar Gamma. Son tres recordatorios, pero todavía no te he dado las horas.';
    const first = await routeMessage(text, user, [], reference) as unknown as RouteView;
    expect(executeTool).not.toHaveBeenCalled();
    const run = await getActiveAgentRun(user, new Date(reference.requestTimeMs));
    expect(run).not.toBeNull();
    expect(run!.status).toBe('waiting_for_input');

    const history = [{ role: 'user', content: text }, { role: 'assistant', content: first.confirmation, entities: first.entities }];
    const second = await routeMessage('En el mismo orden: a las 8 de la mañana, a las 10 de la mañana y a las 12 del mediodía.', user, history, reference) as unknown as RouteView;
    assertCompleteDecision(2);
    expect(executeTool).toHaveBeenCalledTimes(3);
    assertReminder(0, 'Alfa', tomorrow(8));
    assertReminder(1, 'Beta', tomorrow(10));
    assertReminder(2, 'Gamma', tomorrow(12));
    expect(second.executionFacts.every((fact) => fact.success && fact.errorCode !== 'TIME_IN_PAST')).toBe(true);
  });

  extendedIt('lets an explicit follow-up correction replace the pending date instead of appending to it', async () => {
    const text = 'Recuérdame mañana revisar Alfa, todavía no sé la hora.';
    const first = await routeMessage(text, user, [], reference) as unknown as RouteView;
    expect(executeTool).not.toHaveBeenCalled();
    const history = [{ role: 'user', content: text }, { role: 'assistant', content: first.confirmation, entities: first.entities }];

    await routeMessage('Mejor el viernes a las 9 de la mañana.', user, history, reference) as unknown as RouteView;
    assertCompleteDecision(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    assertReminder(0, 'Alfa', '2026-09-11T14:00:00.000Z');
  });

  extendedIt('completes two timed requests, asks only for the missing one, and continues without recreating the completed items', async () => {
    const text = 'Mañana al mediodía recuérdame revisar Alfa; también mañana a las 9 de la mañana revisar Beta; y también recuérdame revisar Gamma mañana, para ese último todavía no te he indicado la hora.';
    const first = await routeMessage(text, user, [], { ...reference, inputModality: 'audio' }) as unknown as RouteView;
    expect(executeTool).toHaveBeenCalledTimes(2);
    assertReminderExists('Alfa', tomorrow(12));
    assertReminderExists('Beta', tomorrow(9));
    expect(first.executionFacts.filter((fact) => fact.requiresClarification)).toHaveLength(1);
    expect(first.confirmation.toLowerCase()).toContain('gamma');
    const history = [{ role: 'user', content: text }, { role: 'assistant', content: first.confirmation, entities: first.entities }];
    const second = await routeMessage('Gamma mañana a las 3 de la tarde.', user, history, reference) as unknown as RouteView;
    assertCompleteDecision(2);
    expect(executeTool).toHaveBeenCalledTimes(3);
    assertReminder(2, 'Gamma', tomorrow(15));
    expect(second.executionFacts).toHaveLength(1);
  });

  extendedIt.each([1, 6, 12])('returns a complete %i-action nullable batch, not a truncated prefix', async (count) => {
    const clauses = Array.from({ length: count }, (_, index) => `a las ${String(index + 6).padStart(2, '0')}:00 recuérdame revisar Prueba${index + 1}`);
    const result = await routeMessage(`Mañana: ${clauses.join('; ')}. Crea un recordatorio separado para cada solicitud.`, user, [], reference) as unknown as RouteView;
    assertCompleteDecision();
    expect(executeTool).toHaveBeenCalledTimes(count);
    expect(result.executionFacts).toHaveLength(count);
    for (let index = 0; index < count; index += 1) assertReminder(index, `Prueba${index + 1}`, tomorrow(index + 6));
  });
  });
});
