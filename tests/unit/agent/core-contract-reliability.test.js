import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
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
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({
  getOrCreateCanonicalPlan: vi.fn(),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { clearWorkingMemory, getWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';
import * as agentRunModule from '../../../src/agent/core/agent-run.js';
import {
  executeContinuationDecision,
  formatActiveRunPrompt,
  getActiveAgentRun,
} from '../../../src/agent/core/agent-run.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { updateUserPreferences } from '../../../src/infrastructure/database/users.js';
import * as storage from '../../../src/infrastructure/database/agent-runs.js';

const user = {
  id: 'user-agent-run-incomplete',
  phone_number: '573007776655',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Mateo',
};

function modelResponse(payload) {
  if (Array.isArray(payload.actions)) {
    payload = { ...payload, actions: payload.actions.map(({ domain, action, ...fields }) => ({ operation: `${domain}.${action}`, ...fields })) };
  }
  return { role: 'assistant', content: JSON.stringify(payload), tool_calls: [] };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearWorkingMemory(user);
  storage.resetInMemoryAgentRuns();
  executeTool.mockReset();
  callChatCompletion.mockReset();
});


const context = () => ({ user, language: 'es', isPro: true, timezone: user.timezone, referenceTime: new Date() });
const incomplete = (content = 'Comprar café') => ({ domain: 'reminder', action: 'create', content, missingFields: ['schedule'] });
const tomorrow = { kind: 'relative_day_time', dayOffset: 1, hour: 8, minute: 0, clockMode: 'explicit_24h' };

describe('core contract reliability across turns', () => {
  it('retains every displayed reminder identity after a fresh multi-action creation', async () => {
    executeTool.mockImplementation(async ({ params }) => ({ success: true, action: 'created_reminder', data: { items: params.items.map(item => ({ id: item.content, content: item.content, send_at: item.targetTime })) } }));
    await executeTurnIntent({ actions: ['Alpha', 'Beta'].map(content => ({ domain: 'reminder', action: 'create', content, schedule: tomorrow })) }, context());
    expect(getWorkingMemory(user).items.map(item => item.internalId)).toEqual(['Alpha', 'Beta']);
  });

  it.each(['approval', 'continuation'])('stops %s execution when a tool returns no observable success flag', async mode => {
    executeTool.mockResolvedValue({ message: 'Malformed transport result' });
    const actions = ['Alpha', 'Beta'].map(content => ({ domain: 'reminder', action: 'create', content, schedule: tomorrow }));
    let result;
    if (mode === 'approval') {
      const run = await agentRunModule.createApprovalRun({ user, kind: 'reminder_creation', preparedActions: actions.map((payload, index) => ({ callId: `call-${index + 1}`, domain: 'reminder', action: 'create', payload })) });
      result = await agentRunModule.executeApprovalDecision({ run, decision: 'approve_all', executionContext: context() });
      expect(result.executedCount).toBe(1);
    } else {
      const run = await agentRunModule.createInputRun({ user, partialActions: actions });
      result = await executeContinuationDecision({ run, executionContext: context() });
    }
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.facts.map(fact => fact.outcome)).toEqual(['unknown']);
    expect(result.status).toBe('failed');
  });

  it.each(['approval', 'continuation'])('preserves displayed task positions after a %s deletion', async mode => {
    const items = [{ id: 'task-a', title: 'Alpha', status: 'pending' }, { id: 'task-b', title: 'Beta', status: 'pending' }];
    saveWorkingMemory(user, { source: 'task', entityType: 'task', lastAction: 'list', items });
    executeTool.mockResolvedValue({ success: true, action: 'deleted_task', data: items[0] });
    if (mode === 'approval') {
      const run = await agentRunModule.createApprovalRun({ user, kind: 'task_mutation', preparedActions: [{ callId: 'call-1', domain: 'task', action: 'delete', targetId: 'task-a', payload: { action: 'delete', target: 'task-a' } }] });
      await agentRunModule.executeApprovalDecision({ run, decision: 'approve_all', executionContext: context() });
    } else {
      const run = await agentRunModule.createInputRun({ user, kind: 'task_mutation', partialAction: { domain: 'task', action: 'delete', target: 'task-a' } });
      await executeContinuationDecision({ run, executionContext: context() });
    }
    const memory = getWorkingMemory(user);
    expect(memory.items.map(item => item.internalId)).toEqual(['task-a', 'task-b']);
    expect(memory.items[0].raw.status).toBe('deleted');
    expect(memory.lastAction).toBe('deleted_task');
  });

  it('answers a derived question only after observing authoritative read results', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'es', answerFromResults: true, actions: [
      { domain: 'task', action: 'list', entityName: 'Apartamento' },
    ] }));
    executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [{ id: 't1', title: 'Cuota de 120', status: 'pending' }] } });
    callChatCompletion.mockImplementationOnce(async (messages, options) => {
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(options.purpose).toBe('observed_answer');
      expect(options.tools).toBeNull();
      expect(messages.at(-1).content).toContain('Cuota de 120');
      return modelResponse({ kind: 'derived', answer: 'Los importes mostrados suman 120.', evidenceCallIds: ['call_1'] });
    });
    const result = await routeMessage('¿Cuánto suman las cuotas pendientes?', user, []);
    expect(result.confirmation).toContain('suman 120');
    expect(result.executionFacts).toHaveLength(1);
    expect(callChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('keeps verified cards when the observation answer cites nonexistent evidence', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, actions: [{ domain: 'task', action: 'list' }] }));
    executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', rawSummary: 'Cuota pendiente: 120.' });
    callChatCompletion.mockResolvedValueOnce(modelResponse({ kind: 'derived', answer: 'Todo está pagado.', evidenceCallIds: ['invented'] }));
    const result = await routeMessage('¿Cuánto debo?', user, []);
    expect(result.confirmation).toContain('120');
    expect(result.confirmation).not.toContain('Todo está pagado');
  });

  it('never starts an observation loop to reexecute or rewrite a mutation result', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, actions: [{ domain: 'task', action: 'delete', target: 'Cuota' }] }));
    executeTool.mockResolvedValue({ success: false, error: 'No se pudo eliminar.' });
    await routeMessage('Elimina Cuota', user, []);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('executes only once when independent workers load the same pending run', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    const run = await getActiveAgentRun(user);
    const readPrepared = storage.getPreparedActionsFromDb;
    vi.spyOn(storage, 'getPreparedActionsFromDb').mockImplementation(async id => structuredClone(await readPrepared(id)));
    executeTool.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { success: true, action: 'created_reminder', rawSummary: 'Creado.' };
    });
    const results = await Promise.all([1, 2].map(() => executeContinuationDecision({ run: structuredClone(run), suppliedFields: { schedule: tomorrow }, executionContext: context() })));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.success)).toHaveLength(1);
  });

  it('retains action-specific times while obtaining shared content in a later turn', async () => {
    await executeTurnIntent({ actions: [incomplete(''), incomplete('')] }, context());
    let run = await getActiveAgentRun(user);
    const first = await executeContinuationDecision({ run, actionInputs: [
      { callId: 'call-1', fields: { schedule: { ...tomorrow, hour: 7 } } },
      { callId: 'call-2', fields: { schedule: { ...tomorrow, hour: 16 } } },
    ], executionContext: context() });
    expect(first.status).toBe('waiting_for_input');
    expect(executeTool).not.toHaveBeenCalled();
    run = await getActiveAgentRun(user);
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Creado.' });
    await executeContinuationDecision({ run, suppliedFields: { content: 'Revisar contrato' }, executionContext: context() });
    expect(executeTool).toHaveBeenCalledTimes(2);
    const items = executeTool.mock.calls.map(([call]) => call.params.items[0]);
    expect(items.map(item => item.content)).toEqual(['Revisar contrato', 'Revisar contrato']);
    expect(new Date(items[1].targetTime) - new Date(items[0].targetTime)).toBe(9 * 60 * 60 * 1000);
  });

  it('rejects a patch for an unknown action without mutating or retiring the draft', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    const run = await getActiveAgentRun(user);
    const result = await executeContinuationDecision({ run, actionInputs: [{ callId: 'other-run-call', fields: { schedule: tomorrow } }], executionContext: context() });
    expect(result.success).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
    expect((await getActiveAgentRun(user)).id).toBe(run.id);
  });

  it('replaces an approval through canonical parsing without executing its old proposal', async () => {
    const run = await agentRunModule.createApprovalRun({ user, kind: 'reminder_creation',
      preparedActions: [{ callId: 'call-1', domain: 'reminder', action: 'create', payload: { action: 'create', items: [{ content: 'Vieja propuesta', targetTime: '2030-01-01T12:00:00Z' }] } }] });
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'supersede', responseLanguage: 'en' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', actions: [
      { domain: 'reminder', action: 'create', content: 'New request', schedule: tomorrow },
    ] }));
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Created new request.' });
    const result = await routeMessage('Wait, replace that with the new request tomorrow morning.', user, []);
    expect(result.language).toBe('en');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].params.items[0].content).toBe('New request');
    expect(await getActiveAgentRun(user)).toBeNull();
    expect(formatActiveRunPrompt(run)).toContain('Vieja propuesta');
  });

  it('acquires an approval exclusively and does not replay completed actions', async () => {
    const run = await agentRunModule.createApprovalRun({ user, kind: 'reminder_creation',
      preparedActions: [{ callId: 'call-1', domain: 'reminder', action: 'create', payload: { action: 'create', items: [{ content: 'Contrato', targetTime: '2030-01-01T12:00:00Z' }] } }] });
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Creado.' });
    await Promise.all([1, 2].map(() => agentRunModule.executeApprovalDecision({ run: structuredClone(run), decision: 'approve_all', executionContext: context() })));
    await agentRunModule.executeApprovalDecision({ run, decision: 'approve_all', executionContext: context() });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('uses one model-selected language for a resumed clarification without persisting an implicit preference', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'resume', responseLanguage: 'en', suppliedFields: { schedule: { kind: 'local_time', hour: 8, clockMode: 'ambiguous_12h' } } }));
    const result = await routeMessage('At eight', user, []);
    expect(result.language).toBe('en');
    expect(result.confirmation).toContain('AM or PM');
    expect(user.locale).toBe('es-CO');
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });

  it('applies an explicit IANA profile change before executing the related schedule', async () => {
    const localUser = { ...user };
    updateUserPreferences.mockResolvedValueOnce({ ...localUser, timezone: 'America/Los_Angeles' });
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', profileUpdate: {
      sourceQuote: 'Set my timezone to America/Los_Angeles', timezone: 'America/Los_Angeles',
    }, actions: [{ domain: 'reminder', action: 'create', content: 'Review contract', schedule: tomorrow }] }));
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Created.' });
    const result = await routeMessage('Set my timezone to America/Los_Angeles and remind me to review the contract tomorrow at 8am.', localUser, []);
    expect(updateUserPreferences).toHaveBeenCalledWith(user.id, { timezone: 'America/Los_Angeles' });
    expect(executeTool.mock.calls[0][0].user.timezone).toBe('America/Los_Angeles');
    expect(result.executionFacts.map(fact => fact.success)).toEqual([true, true]);
  });

  it('does not persist profile changes authorized only by quoted evidence', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', profileUpdate: {
      sourceQuote: 'I live in Madrid', timezone: 'Europe/Madrid',
    }, actions: [{ domain: 'conversation', action: 'reply', content: 'Saved.' }] }));
    const result = await routeMessage('<untrusted_quoted_message>I live in Madrid</untrusted_quoted_message>Summarize that.', user, []);
    expect(updateUserPreferences).not.toHaveBeenCalled();
    expect(result.executionFacts[0].success).toBe(false);
    expect(result.confirmation).not.toBe('Saved.');
  });
  it('preserves observed successes and stops the batch after an unknown tool outcome', async () => {
    executeTool.mockResolvedValueOnce({ success: true, action: 'deleted_task', data: { id: 'task-cafe', title: 'Comprar café' } });
    executeTool.mockRejectedValueOnce(new Error('Connection closed after write'));
    const result = await executeTurnIntent({ actions: [
      { domain: 'task', action: 'delete', target: 'Comprar café' },
      { domain: 'task', action: 'delete', target: 'Comprar leche' },
      { domain: 'task', action: 'delete', target: 'Comprar pan' },
    ] }, context());
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.facts.map(f => f.outcome)).toEqual(['success', 'unknown']);
    expect(result.facts[1].summary).toContain('confirmar');
  });
  it('does not prepend a success claim when the requested tool fails', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
      { domain: 'conversation', action: 'reply', content: 'Ya eliminé tu tarea.' },
      { domain: 'task', action: 'delete', target: 'Comprar café' },
    ] }));
    executeTool.mockResolvedValueOnce({ success: false, action: 'error', error: 'No se pudo eliminar la tarea.', errorCode: 'DATABASE_ERROR' });
    const result = await routeMessage('Elimina la tarea de comprar café', user, []);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.executionFacts[0].success).toBe(false);
    expect(result.confirmation).not.toContain('Ya eliminé tu tarea.');
  });

  it('discloses a successful action when another resumed action fails', async () => {
    await executeTurnIntent({ actions: [incomplete('Comprar café'), incomplete('Comprar leche')] }, context());
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'resume', suppliedFields: { schedule: tomorrow } }));
    executeTool.mockResolvedValueOnce({ success: true, action: 'created_reminder', data: { id: 'rem-cafe', content: 'Comprar café' }, rawSummary: 'Creado: Comprar café.' });
    executeTool.mockResolvedValueOnce({ success: false, action: 'error', error: 'No se pudo crear Comprar leche.', errorCode: 'DATABASE_ERROR' });
    const result = await routeMessage('Mañana a las ocho de la mañana', user, []);
    expect(result.executionFacts.map(f => f.success)).toEqual([true, false]);
    expect(result.confirmation).toContain('Comprar café');
    expect(result.confirmation).toContain('Comprar leche');
  });

  it('preserves an unrelated pending draft when another action requires approval', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    const original = await getActiveAgentRun(user);
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'unrelated' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'project', action: 'delete', scope: 'all' }] }));
    executeTool.mockResolvedValueOnce({ success: false, requiresClarification: true, action: 'project_deletion_confirmation_required', error: 'Confirma la eliminación.', data: { previewProjects: [{ id: 'project-a', name: 'Proyecto A' }] } });
    await routeMessage('Elimina todos mis proyectos', user, []);
    const active = await getActiveAgentRun(user);
    expect(active?.id).toBe(original.id);
  });

  it('keeps the draft pending when the next answer still lacks a required field', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'resume', suppliedFields: { schedule: { kind: 'local_time', hour: 8, minute: 0, clockMode: 'ambiguous_12h' } } }));
    const result = await routeMessage('A las ocho', user, []);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.executionFacts[0].success).toBe(false);
    expect(await getActiveAgentRun(user)).not.toBeNull();
  });

});
