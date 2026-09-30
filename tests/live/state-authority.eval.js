import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoAmounts, assertReadFailureEvidence, assertTaskReadEvidence } from '../helpers/state-authority.js';

// Only external state and side effects are replaced. The router, schema,
// provider client, real model decision, task read tool, and presentation run.
vi.mock('../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../src/features/tasks/service.js', () => ({ getTaskList: vi.fn() }));
vi.mock('../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockRejectedValue(new Error('State writes are forbidden in this evaluation.')),
}));
vi.mock('../../src/agent/core/agent-run.js', () => ({
  getActiveAgentRun: vi.fn().mockResolvedValue(null),
  executeApprovalDecision: vi.fn().mockRejectedValue(new Error('Approvals are outside this evaluation.')),
  executeContinuationDecision: vi.fn().mockRejectedValue(new Error('Continuations are outside this evaluation.')),
  formatActiveRunPrompt: vi.fn(() => ''),
}));
vi.mock('../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.invalid/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../src/agent/orchestration/router.js';
import { executeTool } from '../../src/agent/tools/index.js';
import { executeTaskReadTool } from '../../src/agent/tools/task-read.js';
import { getTaskList } from '../../src/features/tasks/service.js';
import { getDailyOverview } from '../../src/infrastructure/database/index.js';
import { retrieveRelevantMemories } from '../../src/features/memory/service.js';
import { clearWorkingMemory } from '../../src/agent/core/working-memory.js';

const referenceTime = Date.parse('2026-09-29T18:00:00Z');
const user = { id: 'authority-eval-user', phone_number: '000000000000', display_name: 'Alex',
  timezone: 'America/Bogota', locale: 'es-CO', is_admin: false };
const task = { id: 'authority-eval-task', title: 'devolver 720.000 pesos', status: 'pending',
  user_id: user.id, entityName: 'Apartamento', due_date: '2026-09-30T17:00:00Z',
  dueDate: '2026-09-30T17:00:00Z', description: null, completed_at: null,
  entities: { id: 'authority-eval-project', name: 'Apartamento', category: 'project' },
  localFormatted: '30/09/2026, 12:00', localTime: '12:00 PM' };
const staleHistory = [
  { role: 'user', content: '¿Cuánto tengo que devolver del apartamento?' },
  { role: 'assistant', content: 'Debes 910.000 pesos al proyecto Apartamento.', intent: 'chat', entities: { _turnMetadata: { kind: 'conversation' } } },
  { role: 'user', content: 'Muéstrame las tareas del apartamento.' },
  { role: 'assistant', content: 'Apartamento: devolver 720.000 pesos; pendiente.', intent: 'task', entities: { _turnMetadata: { kind: 'operational_result' } } },
  { role: 'user', content: '¿Y cuánto me queda?' },
  { role: 'assistant', content: 'Te quedan 190.000 pesos después de devolver 720.000.', intent: 'chat', entities: { _turnMetadata: { kind: 'conversation' } } },
];

const report = { revision: process.env.GITHUB_SHA || 'local', synthetic: true, cases: [] };
let networkCalls = 0;
let callsAtStart = 0;
let result;
let violations = [];
let blockedNetwork = [];
let nativeFetch;

beforeAll(() => {
  if (process.env.HERMES_AUTHORITY_LIVE !== '1' || !process.env.OPENROUTER_API_KEY) {
    throw new Error('Live evaluation needs HERMES_AUTHORITY_LIVE=1 and OPENROUTER_API_KEY. No model response is mocked.');
  }
  nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url));
    if (url.href !== 'https://openrouter.ai/api/v1/chat/completions' || options.method !== 'POST') {
      blockedNetwork.push(`${url.origin}${url.pathname}`);
      throw new Error('Only the model endpoint is allowed. Database, billing and WhatsApp network access are blocked.');
    }
    networkCalls += 1;
    if (networkCalls > 30) throw new Error('Live evaluation request budget exceeded.');
    return nativeFetch(input, { ...options, redirect: 'error' });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
  callsAtStart = networkCalls;
  result = undefined;
  violations = [];
  blockedNetwork = [];
  retrieveRelevantMemories.mockResolvedValue([]);
  getDailyOverview.mockResolvedValue({ pendingConfirmationReminders: [], pendingTasksByEntity: { Apartamento: [task] } });
  getTaskList.mockImplementation(async (params) => {
    if (params.userId !== user.id) throw new Error('Unexpected fixture owner.');
    if (params.entityName !== 'Apartamento') throw new Error('The evaluation must read the named project.');
    const requestedStatus = params.status || 'pending';
    const records = ['pending', 'all'].includes(requestedStatus) ? [structuredClone(task)] : [];
    // Fixture read supports literal query filtering just like the domain, not a
    // phrase-based financial classifier. An incorrect query must not look valid.
    const query = String(params.query || '').toLowerCase().trim();
    const tasks = query ? records.filter((record) => record.title.toLowerCase().includes(query)) : records;
    return { tasks, items: tasks.map((record, index) => ({ position: index + 1, internalId: record.id,
      type: 'task', summary: record.title, source: 'task', raw: record, entityName: 'Apartamento' })),
      entityName: 'Apartamento', scope: params.scope || 'all_pending', timezone: user.timezone, locale: user.locale };
  });
  executeTool.mockImplementation(async (args) => {
    if (args.toolName !== 'manage_task' || args.params?.action !== 'list') {
      violations.push({ tool: args.toolName, action: args.params?.action });
      throw new Error('Only task reads are allowed in this synthetic evaluation.');
    }
    return executeTaskReadTool(args);
  });
});

afterEach((context) => {
  const entry = { name: context.task.name, modelRequests: networkCalls - callsAtStart,
    intent: result?.intent || null, actions: result?.plan?.actions || [],
    evidence: (result?.executionFacts || []).map((fact) => ({ tool: fact.tool, action: fact.action, success: fact.success })),
    confirmation: result?.confirmation || null, forbiddenActions: violations, blockedNetwork };
  report.cases.push(entry);
  console.info('[authority-eval]', JSON.stringify(entry));
  expect(violations, 'The model must not turn a query into a mutation.').toEqual([]);
  expect(blockedNetwork, 'No non-model network request may be attempted.').toEqual([]);
  expect(networkCalls - callsAtStart, 'This must exercise the real provider, not a mock.').toBeGreaterThan(0);
});

afterAll(() => {
  clearWorkingMemory(user);
  vi.unstubAllGlobals();
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/state-authority-live.json', JSON.stringify({ ...report, networkCalls }, null, 2));
});

async function ask(text, history = [], options = {}) {
  result = await routeMessage(text, { ...user }, structuredClone(history), { requestTimeMs: referenceTime,
    correlationId: `authority-eval-${report.cases.length + 1}`, ...options });
  return result;
}

function expectCurrentTask() {
  assertTaskReadEvidence(result, { expectedIds: [task.id], forbiddenAmounts: [910000, 190000] });
  expect(result.confirmation).toContain('720.000');
}

describe('real-model state authority with synthetic I/O', () => {
  it('reads the current project even with a clean history', async () => {
    await ask('¿Cuánto tengo que devolver del apartamento?');
    expectCurrentTask();
  });
  it('does not use a stale personal-memory debt as live task evidence', async () => {
    retrieveRelevantMemories.mockResolvedValue([{ category: 'fact', content: 'El usuario debe 910000 pesos al proyecto Apartamento.' }]);
    await ask('¿Cuánto tengo que devolver del apartamento?');
    expectCurrentTask();
  });
  it('handles the audio transcription without reusing a false historical remainder', async () => {
    await ask('Oye, ¿cuánto dejo del apartamento?', staleHistory, { inputModality: 'audio' });
    expectCurrentTask();
  });
  it('does not let a stored debt and stale assistant replies overrule a pending task', async () => {
    retrieveRelevantMemories.mockResolvedValue([{ category: 'fact', content: 'El usuario debe 910000 pesos al proyecto Apartamento.' }]);
    await ask('¿Cuánto me queda por devolver del apartamento?', staleHistory);
    expectCurrentTask();
  });
  it('retains project-reference continuity but rereads rather than copying a prior balance', async () => {
    await ask('¿Y cuánto me queda por devolver ahí?', staleHistory);
    expectCurrentTask();
  });
  it('does not fabricate a balance when the read fails', async () => {
    getDailyOverview.mockResolvedValue(null);
    getTaskList.mockRejectedValue(new Error('Synthetic read unavailable.'));
    await ask('Consulta cuánto tengo que devolver del apartamento.', staleHistory);
    assertReadFailureEvidence(result, [720000, 910000, 190000]);
  });
  it('does not reuse a cancelled task after a successful empty read', async () => {
    getDailyOverview.mockResolvedValue({ pendingTasksByEntity: {} });
    getTaskList.mockResolvedValue({ tasks: [], items: [], entityName: 'Apartamento',
      scope: 'all_pending', timezone: user.timezone, locale: user.locale });
    await ask('¿Qué devolución tengo pendiente del apartamento?', staleHistory);
    assertTaskReadEvidence(result, { expectedIds: [], forbiddenAmounts: [720000, 910000, 190000] });
  });
  it('preserves ordinary conversation without forcing an operational read', async () => {
    getDailyOverview.mockResolvedValue(null);
    await ask('Hoy fue un día pesado. Solo quería conversar un rato.');
    expect(result.intent).toBe('chat');
    expect(result.confirmation.length).toBeGreaterThan(0);
    expect(executeTool).not.toHaveBeenCalled();
    assertNoAmounts(result, [720000, 910000, 190000]);
  });
  it('preserves direct recall of durable personal communication preferences', async () => {
    getDailyOverview.mockResolvedValue(null);
    retrieveRelevantMemories.mockResolvedValue([{ category: 'preference', content: 'Alex prefiere respuestas breves en español.' }]);
    await ask('¿Cómo prefiero que me respondas?');
    expect(result.intent).toBe('chat');
    expect(result.confirmation.length).toBeGreaterThan(0);
    expect(executeTool).not.toHaveBeenCalled();
  });
});
