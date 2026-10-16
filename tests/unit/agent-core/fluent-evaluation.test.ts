import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { readFileSync, writeFileSync } from 'node:fs';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
import type { AIResponse, ReminderRecord, TurnContext } from '@templelabs/contracts';
import { main, turns, gradeTurn, createSyntheticReminders, runConversation, SYNTHETIC_USER } from '../../../scripts/evals/v2-fluent-conversation.js';

const context: TurnContext = { userId: SYNTHETIC_USER, runId: 'fixture', requestId: 'fixture', language: 'es', timezone: 'America/Bogota', referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal, capabilities: new Set(['reminders.create', 'reminders.read', 'reminders.update', 'reminders.cancel']) };
const record: ReminderRecord = { id: '22222222-2222-4222-8222-000000000001', content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00Z', recurrence: null, isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null, status: 'pending' };
const answer = (calls: AIResponse['message']['toolCalls'] = [], text = ''): AIResponse => ({ message: { role: 'assistant', content: text, toolCalls: calls }, stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 20, outputTokens: 10 } });

describe('bounded fluent evaluation (offline only)', () => {
  it('runs only the two mixed turns in directed mode, with fixed smaller limits and no full-run proof', async () => {
    const provider = new MockAIProvider([
      answer([{ id: 'first', name: 'reminder_create', arguments: { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue' } }]),
      answer([{ id: 'clarify', name: 'conversation_clarify', arguments: { domain: 'reminders', missing: 'today_or_tomorrow' } }]),
      answer([{ id: 'second', name: 'reminder_create', arguments: { content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00Z', turnDisposition: 'finish' } }]),
    ].map(response => ({ response })));
    const forTurn = vi.fn(() => provider);
    const report = await runConversation({ forTurn, directed: true });
    expect(forTurn).toHaveBeenCalledTimes(2);
    expect(report.script).toEqual(turns.slice(0, 2));
    expect(report.turns).toHaveLength(2);
    expect(report.passedTurns).toBe(2);
    expect(report.failedChecks).toBe(0);
    expect(report.incomplete).toBe(false);
    expect(report.limits).toMatchObject({ userTurns: 2, maxCalls: 6, maxUsd: 0.02, maxInputTokens: 2500, maxOutputTokens: 2048 });
    expect(report.receipts).toHaveLength(2);
    expect(report.finalRecords).toHaveLength(2);
    expect(report.liveProof).toBe(false);
    expect(report.directedProof).toBe(false);
  });
  it('prints only the two-turn directed dry plan without credentials, fetch, or report writes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK FORBIDDEN'));
    const output: string[] = [];
    vi.mocked(readFileSync).mockClear(); vi.mocked(writeFileSync).mockClear();
    try {
      expect(await main(['--directed'], text => output.push(text))).toBe(0);
      expect(output.join('\n')).toContain('2. mañana');
      expect(output.join('\n')).not.toContain('3. Muéstrame');
      expect(output.join('\n')).toContain('US$0.02');
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(await main(['--directed', '--directed'], () => {})).toBe(2);
    } finally { fetch.mockRestore(); }
  });
  it('directed mode preserves the unknown-accounting lock before the next user turn', async () => {
    let blocked = false;
    const complete = vi.fn(async () => { blocked = true; return answer([], 'No sé.'); });
    const forTurn = vi.fn(() => ({ capabilities: { toolCalling: true, structuredOutput: false }, complete }));
    const report = await runConversation({ directed: true, forTurn, live: true, budgetReport: () => ({ calls: Number(blocked), chargedUsd: 0, reservedUsd: blocked ? 0.001 : 0, blockedReason: blocked ? 'missing usage or provider error' : null, attempts: [] }) });
    expect(report.turns).toHaveLength(1);
    expect(report.incomplete).toBe(true);
    expect(report.stoppedReason).toBe('missing usage or provider error');
    expect(report.liveProof).toBe(false);
    expect(report.directedProof).toBe(false);
    expect(forTurn).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(report.finalRecords).toEqual([]);
    expect(report.receipts).toEqual([]);
  });
  it('has exactly 20 chained Spanish messages and the exact mixed acceptance opening', () => {
    expect(turns).toHaveLength(20);
    expect(turns[0]?.text).toBe('Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana');
    expect(turns[1]?.text).toBe('mañana');
    expect(turns.map(t => t.text).join(' ')).not.toMatch(/calendario|tarea/i);
  });
  it('help and default dry mode never fetch, read credentials, or write reports', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK FORBIDDEN'));
    const output: string[] = [];
    vi.mocked(readFileSync).mockClear(); vi.mocked(writeFileSync).mockClear();
    try {
      expect(await main(['--help'], text => output.push(text))).toBe(0);
      expect(await main([], text => output.push(text))).toBe(0);
      expect(output.join('\n')).toContain('--pricing');
      expect(output.join('\n')).toContain('--live');
      expect(output.join('\n')).toContain('60');
      expect(output.join('\n')).toContain('0.25');
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('rejects limit overrides and missing live arguments before network', async () => {
    expect(await main(['--max-calls', '61'], () => {})).toBe(2);
    expect(await main(['--live'], () => {})).toBe(2);
  });
  it('grades missing typed question and duplicate first writes as failures', () => {
    const checks = gradeTurn(0, { before: [], after: [record], operations: [{ request: { operation: 'create', input: { content: record.content, targetTimeIso: record.sendAt! } }, ids: [record.id], wrote: true }], reply: 'Preparar reunión 4:00 PM', clarification: null, reads: [] });
    expect(checks.find(c => c.name === 'typed clarification')?.pass).toBe(false);
    const duplicate = gradeTurn(1, { before: [record], after: [record, { ...record, id: 'duplicate' }], operations: [{ request: { operation: 'create', input: { content: record.content, targetTimeIso: record.sendAt! } }, ids: ['duplicate'], wrote: true }], reply: '', clarification: null, reads: [] });
    expect(duplicate.some(c => !c.pass)).toBe(true);
  });
  it('rejects wrong ordinal targets, incorrect read lists, and writes on the invalid-ID turn', () => {
    const second = { ...record, id: '22222222-2222-4222-8222-000000000002', content: 'Enviar informe', sendAt: '2026-10-12T15:00:00Z' };
    const wrong = gradeTurn(8, { before: [record, second], after: [{ ...record, status: 'cancelled' }, second], operations: [{ request: { operation: 'cancel', input: { reminderId: record.id } }, ids: [record.id], wrote: true }], reply: '', clarification: null, reads: [] });
    expect(wrong.find(c => c.name === 'operation and stable target')?.pass).toBe(false);
    const list = gradeTurn(3, { before: [record, second], after: [record, second], operations: [], reads: [[record]], reply: record.content, clarification: null });
    expect(list.find(c => c.name === 'read list IDs and order')?.pass).toBe(false);
    const rejected = gradeTurn(13, { before: [record], after: [{ ...record, status: 'cancelled' }], operations: [{ request: { operation: 'cancel', input: { reminderId: record.id } }, ids: [record.id], wrote: true }], reply: '', clarification: null, reads: [] });
    expect(rejected.find(c => c.name === 'exact write count')?.pass).toBe(false);
    expect(rejected.find(c => c.name === 'stored records unchanged')?.pass).toBe(false);
  });
  it('stores real typed parameters, deduplicates operation IDs, preserves IDs, and rejects unknown targets without writes', async () => {
    const port = createSyntheticReminders();
    const create = { operation: 'create' as const, input: { content: record.content, targetTimeIso: record.sendAt! } };
    const one = await port.execute(create, context, 'create-1');
    expect(one.status).toBe('success');
    expect(await port.execute(create, context, 'create-1')).toEqual(one);
    expect(port.snapshot()).toHaveLength(1);
    expect(port.operations.filter(o => o.wrote)).toHaveLength(1);
    expect(await port.execute({ ...create, input: { ...create.input, content: 'Conflict' } }, context, 'create-1')).toMatchObject({ status: 'validation_failed', code: 'OPERATION_ID_CONFLICT' });
    expect(port.snapshot()).toHaveLength(1);
    expect(port.operations.filter(o => o.wrote)).toHaveLength(1);
    const id = port.snapshot()[0]!.id;
    await port.execute({ operation: 'update', input: { reminderId: id, targetTimeIso: '2026-10-11T22:00:00Z' } }, context, 'update');
    expect(port.snapshot()[0]).toMatchObject({ id, sendAt: '2026-10-11T22:00:00Z' });
    const before = port.snapshot();
    const writes = port.operations.filter(o => o.wrote).length;
    const rejected = await port.execute({ operation: 'cancel', input: { reminderId: '99999999-9999-4999-8999-999999999999' } }, context, 'bad');
    expect(rejected.status).toBe('validation_failed');
    expect(port.snapshot()).toEqual(before);
    expect(port.operations.filter(o => o.wrote)).toHaveLength(writes);
    const read = await port.execute({ operation: 'read', input: { filter: 'tomorrow' } }, context, 'read');
    expect(read).toMatchObject({ status: 'success', data: { records: [] } });
    expect(port.snapshot()).toEqual(before);
    await port.execute({ operation: 'cancel', input: { reminderId: id } }, context, 'cancel');
    expect(port.snapshot()[0]).toMatchObject({ id, status: 'cancelled' });
  });
  it('does not label live selection alone as successful live proof and stops on blocked accounting', async () => {
    const provider = new MockAIProvider(Array.from({ length: 20 }, () => ({ response: answer([{ id: 'dialogue', name: 'conversation_decide', arguments: { ready: [], reply: 'No sé.' } }]) })));
    const selected = await runConversation({ forTurn: () => provider, live: true });
    expect(selected.liveProof).toBe(false);
    expect(selected.failedTurns).toBeGreaterThan(0);
    expect(selected.failedTurns + selected.passedTurns).toBe(20);
    const blocked = await runConversation({ forTurn: () => { throw new Error('must not create a provider'); }, budgetReport: () => ({ calls: 1, chargedUsd: 0, reservedUsd: 0.01, blockedReason: 'missing usage or provider error', attempts: [] }) });
    expect(blocked.turns).toHaveLength(0);
    expect(blocked.incomplete).toBe(true);
    expect(blocked.stoppedReason).toBe('missing usage or provider error');
  });
  it('checks the shared accounting lock after a turn and never starts the next provider', async () => {
    let blocked = false;
    const complete = vi.fn(async () => { blocked = true; return answer([], 'No sé.'); });
    const forTurn = vi.fn(() => ({ capabilities: { toolCalling: true, structuredOutput: false }, complete }));
    const report = await runConversation({ forTurn, budgetReport: () => ({ calls: Number(blocked), chargedUsd: 0, reservedUsd: blocked ? 0.01 : 0, blockedReason: blocked ? 'missing usage or provider error' : null, attempts: [] }) });
    expect(report.turns).toHaveLength(1);
    expect(report.incomplete).toBe(true);
    expect(report.stoppedReason).toBe('missing usage or provider error');
    expect(forTurn).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('continues 20 turns as degraded for non-accounting input limits without raising limits or calling inference', async () => {
    const complete = vi.fn(async () => answer());
    const report = await runConversation({ forTurn: () => ({ capabilities: { toolCalling: true, structuredOutput: false }, complete, estimateNativeInput: () => 100000 }) });
    expect(report.turns).toHaveLength(20);
    expect(report.degraded).toBe(true);
    expect(report.stoppedReason).toBeNull();
    expect(report.limits.maxInputTokens).toBe(2500);
    expect(report.failedTurns).toBe(20);
    expect(complete).not.toHaveBeenCalled();
  });
  it('runs durable two-turn S2 with retained receipts/checkpoints then continues all 20 despite semantic failures', async () => {
    const provider = new MockAIProvider([
      answer([{ id: 'first', name: 'reminder_create', arguments: { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue' } }]),
      answer([{ id: 'clarify', name: 'conversation_clarify', arguments: { domain: 'reminders', missing: 'today_or_tomorrow' } }]),
      answer([{ id: 'second', name: 'reminder_create', arguments: { content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00Z', turnDisposition: 'finish' } }]),
      ...Array.from({ length: 18 }, () => answer([{ id: 'dialogue', name: 'conversation_decide', arguments: { ready: [], reply: 'No sé.' } }])), 
    ].map(response => ({ response })));
    const report = await runConversation({ forTurn: () => provider });
    expect(report.turns).toHaveLength(20);
    expect(report.turns[0]!.checks.every(c => c.pass)).toBe(true);
    expect(report.turns[1]!.checks.every(c => c.pass)).toBe(true);
    expect(report.turns[0]!.checkpoints.at(-1)).toMatchObject({ agentCoreProductivity: { phase: 'completed' } });
    expect(report.receipts).toHaveLength(2);
    expect(report.failedTurns).toBeGreaterThan(0);
    expect(report.incomplete).toBe(false);
    expect(report.liveProof).toBe(false);
    expect(provider.requests.length).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('mañana');
    expect(provider.requests.flatMap(request => request.tools.map(tool => tool.name))).not.toContain('reminder_acknowledge');
  });
});
