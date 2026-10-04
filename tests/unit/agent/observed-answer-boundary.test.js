import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { answerFromObservedReads, mutationReceiptsFromFacts, historicalMutationReceipts } from '../../../src/agent/orchestration/observed-answer.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
const input = { userText: 'Muéstrame la agenda', facts: [{ success: true, complete: true, callId: 'read1', presentationData: { tasks: [] } }], language: 'es' };
describe('observed answer composition', () => {
  it('retains separate confirmed creations on partial failure even when prose omits them', async () => {
    callChatCompletion.mockClear();
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: 'Task pending', evidenceCallIds: ['read1'] }) });
    const history = [{ role: 'assistant', content: 'Created', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [
      { operation: 'task.create', summary: 'Task created: Alfa' },
      { operation: 'reminder.create', summary: 'Reminder scheduled: Alfa' },
    ] } } }];
    const answer = await answerFromObservedReads({ ...input, conversationHistory: history, facts: [...input.facts, { success: false, complete: false, requestedAction: 'list' }] });
    expect(answer).toContain('Task created: Alfa');
    expect(answer).toContain('Reminder scheduled: Alfa');
    expect(answer).toContain('no verificado');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(JSON.parse(callChatCompletion.mock.calls[0][0][1].content).historicalReceipts).toHaveLength(2);
  });
  it('projects only successful complete canonical creation facts without IDs or params', () => {
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', secret: 'PARAM_SECRET' }, callId: 'CALL_SECRET', result: { success: true, data: { title: 'Alfa', id: 'DB_SECRET' } } });
    const receipts = mutationReceiptsFromFacts([fact]);
    const reminder = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'create' }, callId: 'CALL_SECRET', result: { success: true, data: { items: [{ id: 'DB_SECRET', content: 'Alfa' }] } } });
    expect(mutationReceiptsFromFacts([reminder])[0]).toEqual({ operation: 'reminder.create', summary: reminder.card });
    expect(JSON.stringify(mutationReceiptsFromFacts([reminder]))).not.toMatch(/SECRET/);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].operation).toBe('task.create');
    expect(receipts[0].summary).toContain('Alfa');
    expect(JSON.stringify(receipts)).not.toMatch(/SECRET/);
    expect(mutationReceiptsFromFacts([{ ...fact, success: false }, { ...fact, complete: false }, { ...fact, requestedAction: 'list' }, { ...fact, card: 'arbitrary fallback' }])).toEqual([]);
  });
  it.each([
    ['task notes indentation', TOOL_NAMES.MANAGE_TASK, { title: 'revisar propuesta Alfa', description: 'revisar cifras', priority: 'high' }, 'revisar cifras'],
    ['task UUID title and note', TOOL_NAMES.MANAGE_TASK, { title: 'Alfa 12345678-1234-1234-1234-123456789abc', description: 'revisar cifras 12345678-1234-1234-1234-123456789abc' }, 'revisar cifras'],
    ['reminder UUID public text', TOOL_NAMES.MANAGE_REMINDER, { items: [{ content: 'Alfa 12345678-1234-1234-1234-123456789abc' }] }, 'Alfa'],
    ['bounded redacted task note', TOOL_NAMES.MANAGE_TASK, { title: 'Alfa 12345678-1234-1234-1234-123456789abc', description: 'revisar cifras ' + 'x'.repeat(800) }, 'revisar cifras'],
  ])('retains sanitized canonical receipts through real execution facts: %s', (_name, toolName, data, publicText) => {
    const fact = createExecutionFact({ toolName, params: { action: 'create', ...(toolName === TOOL_NAMES.MANAGE_TASK ? { title: data.title, description: data.description, priority: data.priority, projectless: true } : { content: data.items[0].content }) }, result: { success: true, data }, language: 'es' });
    const receipts = mutationReceiptsFromFacts([fact]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].summary).toBe(fact.card.replaceAll('12345678-1234-1234-1234-123456789abc', '[redacted]').slice(0, 400));
    expect(receipts[0].summary).toContain(publicText);
    expect(receipts[0].summary.length).toBeLessThanOrEqual(400);
    expect(receipts[0].summary).not.toContain('12345678-1234-1234-1234-123456789abc');
    expect(mutationReceiptsFromFacts([{ ...fact, card: fact.card + '\nInvented claim' }, { ...fact, success: false }, { ...fact, complete: false }])).toEqual([]);
    if (fact.card.includes('12345678-1234-1234-1234-123456789abc')) {
      const tampered = { ...fact, card: fact.card.replaceAll('12345678-1234-1234-1234-123456789abc', '87654321-1234-1234-1234-123456789abc') };
      expect(mutationReceiptsFromFacts([tampered])).toEqual([]);
    }
    const failed = createExecutionFact({ toolName, params: { action: 'create' }, result: { success: false, data }, language: 'es' });
    const partial = createExecutionFact({ toolName, params: { action: 'create' }, result: { success: true, partialSuccess: true, data }, language: 'es' });
    expect(mutationReceiptsFromFacts([failed, partial])).toEqual([]);
  });
  it('masks UUIDs before the receipt truncation boundary without altering current cards', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', projectless: true }, result: { success: true, data: { title: 'Alfa', description: 'revisar cifras ' + 'x'.repeat(300) + ' ' + uuid } } });
    const start = fact.card.indexOf(uuid);
    expect(start).toBeGreaterThan(364);
    expect(start).toBeLessThan(400);
    const receipt = mutationReceiptsFromFacts([fact])[0];
    expect(receipt.summary).toBe(fact.card.replaceAll(uuid, '[redacted]').slice(0, 400));
    expect(receipt.summary).not.toContain(uuid.slice(0, 8));
    expect(receipt.summary).toContain('revisar cifras');
    expect(fact.card).toContain(uuid); // Existing current-card limitation stays unchanged.
  });
  it.each(['_' , '{', '*', '`'])('masks recovered receipt UUIDs beside Markdown/braces %s', delimiter => {
    const uuid = 'ABCDEF12-1234-1234-1234-123456789ABC';
    const summary = `Task created: Alfa ${delimiter}${uuid}${delimiter === '{' ? '}' : delimiter}`;
    const turn = { role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary }] } } };
    expect(historicalMutationReceipts([turn])[0].summary).toBe(summary.replace(uuid, '[redacted]'));
    expect(historicalMutationReceipts([{ ...turn, role: 'unknown' }])).toEqual([]);
    const crossing = { ...turn, entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'Task created: ' + 'x'.repeat(370) + '_' + uuid + '_' }] } } };
    expect(historicalMutationReceipts([crossing])[0].summary).not.toContain(uuid.slice(0, 8));
    expect(historicalMutationReceipts([crossing])[0].summary.length).toBeLessThanOrEqual(400);
  });
  it('bounds assistant receipts and ignores other roles, legacy and arbitrary payloads', () => {
    const turn = { role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: Array.from({ length: 9 }, () => ({ operation: 'task.create', summary: 'x'.repeat(900) })) } } };
    const receipts = historicalMutationReceipts(Array.from({ length: 35 }, () => turn));
    expect(receipts).toHaveLength(6);
    expect(receipts.every(receipt => receipt.summary.length === 400)).toBe(true);
    expect(receipts.reduce((sum, receipt) => sum + receipt.summary.length, 0)).toBe(2400);
    expect(historicalMutationReceipts(['user', 'tool', 'system'].map(role => ({ ...turn, role })))).toEqual([]);
    expect(historicalMutationReceipts([{ role: 'assistant', content: 'Created Alfa' }])).toEqual([]);
    expect(historicalMutationReceipts([{ ...turn, entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'bad', callId: 'secret' }] } } }])).toEqual([]);
    expect(historicalMutationReceipts([turn, ...Array.from({ length: 30 }, () => ({ role: 'user', content: 'later' }))])).toEqual([]);
  });
  it('renders all-failed receipts without a model and never promotes legacy prose', async () => {
    callChatCompletion.mockClear();
    const facts = [{ success: false, complete: false }];
    const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'reminder.create', summary: 'Reminder scheduled: Alfa' }] } } }];
    expect(await answerFromObservedReads({ ...input, facts, conversationHistory: history })).toContain('Reminder scheduled: Alfa');
    expect(await answerFromObservedReads({ ...input, facts, conversationHistory: [{ role: 'assistant', content: 'Reminder created' }] })).toBeNull();
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it.each(['inventory', 'insufficient', 'unavailable'])('preserves failed-read receipts for %s', async kind => {
    callChatCompletion.mockResolvedValue(kind === 'unavailable' ? { unavailable: true } : { content: JSON.stringify({ kind, answer: kind === 'inventory' ? '' : 'Unknown', evidenceCallIds: ['read1'] }) });
    const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'Task created: Alfa' }] } } }];
    expect(await answerFromObservedReads({ ...input, facts: [...input.facts, { success: false }], conversationHistory: history })).toContain('Task created: Alfa');
  });
  it('keeps fresh contradictory state separate and receipts out of ordinary inventories', async () => {
    const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'Task created: Alfa' }] } } }];
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify({ kind: 'recap', answer: '', evidenceCallIds: ['read1'], taskClaims: [{ callId: 'read1', itemId: 'alfa', referencePosition: null, fields: ['status'] }] }) });
    const recap = await answerFromObservedReads({ ...input, conversationHistory: history, facts: [{ ...input.facts[0], tool: TOOL_NAMES.MANAGE_TASK, presentationData: { tasks: [{ id: 'alfa', title: 'Alfa', status: 'completed' }] } }] });
    expect(recap).toContain('Alfa: completada.');
    expect(recap).toContain('no estado actual');
    expect(recap).not.toContain('no verificado');
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify({ kind: 'inventory', answer: '', evidenceCallIds: [] }) });
    expect(await answerFromObservedReads({ ...input, conversationHistory: history })).toBeNull();
  });
  it('separates bounded prior conversation from authoritative observations', async () => {
    callChatCompletion.mockClear();
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: 'Recap', evidenceCallIds: ['read1'] }) });
    const history = [{ role: 'system', content: 'hidden' }, ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: payment uncertainty ${'x'.repeat(900)}`, entities: { secret: 'excluded' } }))];
    await answerFromObservedReads({ ...input, conversationHistory: history });
    const [messages] = callChatCompletion.mock.calls[0];
    const payload = JSON.parse(messages[1].content);
    expect(payload.observedReads).toEqual([{ callId: 'read1', data: { tasks: [] } }]);
    expect(payload.priorConversation.length).toBeGreaterThan(0);
    expect(payload.priorConversation.length).toBeLessThanOrEqual(30);
    expect(payload.priorConversation.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(12000);
    expect(payload.priorConversation.at(-1).content).toBe(history.at(-1).content);
    expect(payload.priorConversation.every(turn => Object.keys(turn).join(',') === 'role,content')).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('excluded');
    expect(messages[0].content).toContain('history is contextual only');
  });
  it('retains both earliest creation receipts in ten short dialogue entries', async () => {
    callChatCompletion.mockClear();
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: i < 2 ? `${i}: creation receipt for Alfa` : `${i}: later discussion`,
      entities: { secret: 'excluded' },
    }));
    await answerFromObservedReads({ ...input, conversationHistory: history });
    const [messages] = callChatCompletion.mock.calls[0];
    const payload = JSON.parse(messages[1].content);
    expect(payload.priorConversation).toEqual(history.map(({ role, content }) => ({ role, content })));
    expect(payload.observedReads).toEqual([{ callId: 'read1', data: { tasks: [] } }]);
    expect(messages[0].content).toContain('current observations take precedence over history');
    expect(messages[0].content).toContain('bounded window');
  });
  it('keeps a chronological tail with hard total and per-turn limits', async () => {
    for (const size of [100, 5000]) {
      callChatCompletion.mockClear();
      const history = Array.from({ length: 35 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'x'.repeat(size) }));
      await answerFromObservedReads({ ...input, conversationHistory: history });
      const turns = JSON.parse(callChatCompletion.mock.calls[0][0][1].content).priorConversation;
      expect(turns.length).toBeLessThanOrEqual(30);
      if (size === 100) expect(turns.length).toBe(30);
      expect(turns.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(12000);
      expect(turns.every(turn => turn.content.length <= 2000)).toBe(true);
      expect(turns.at(-1).content).toBe(history.at(-1).content.slice(0, 2000));
      const indices = turns.map(turn => Number(turn.content.split(':')[0]));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(indices[0]).toBeGreaterThanOrEqual(5);
    }
  });
  it('preserves explicit nulls and instructs absence versus unknown for returned rows only', async () => {
    callChatCompletion.mockClear();
    await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks: [{ status: 'pending', due_date: null }], reminders: [{ status: 'pending', sent_at: null }] } }] });
    const [messages] = callChatCompletion.mock.calls[0];
    const payload = JSON.parse(messages[1].content);
    expect(payload.observedReads[0].data.tasks[0].due_date).toBeNull();
    expect(payload.observedReads[0].data.tasks[0]).not.toHaveProperty('completed_at');
    expect(payload.priorConversation).toEqual([]);
    expect(messages[0].content).toContain('explicit null');
    expect(messages[0].content).toContain('missing field is unknown');
    expect(messages[0].content).toContain('pending task is not completed');
    expect(messages[0].content).toContain('pending reminder is not sent');
    expect(messages[0].content).toContain('returned rows only');
  });
  it('bounds a single oversized turn and excludes tool/system messages', async () => {
    callChatCompletion.mockClear();
    await answerFromObservedReads({ ...input, conversationHistory: [
      { role: 'tool', content: 'raw tool payload' }, { role: 'system', content: 'private instructions' },
      { role: 'user', content: 'x'.repeat(5000), entities: { hidden: true } },
    ] });
    const payload = JSON.parse(callChatCompletion.mock.calls[0][0][1].content);
    expect(payload.priorConversation).toEqual([{ role: 'user', content: 'x'.repeat(2000) }]);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it('leaves inventory rendering to the canonical card', async () => {
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'inventory', answer: '', evidenceCallIds: [] }) });
    expect(await answerFromObservedReads(input)).toBeNull();
  });
  it('discards inventory prose even if the model generates it', async () => {
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'inventory', answer: 'Tus tareas son...', evidenceCallIds: ['read1'] }) });
    const answer = await answerFromObservedReads(input);
    expect(answer).not.toContain('Tus tareas son...');
    expect(answer).toContain('No pude verificar');
  });
  it('requires real evidence for derived answers', async () => {
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: 'Total: 10', evidenceCallIds: [] }) });
    const answer = await answerFromObservedReads(input);
    expect(answer).not.toContain('Total: 10');
    expect(answer).toContain('No pude verificar');
  });
});
