import { describe, expect, it, vi } from 'vitest';
import { createReminderTools, ToolRegistry, defineTool } from '@templelabs/tools';
import {
  reminderCreateInputSchema, reminderResultSchema, type ReminderResult, type TurnContext,
} from '@templelabs/contracts';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import type { LegacyToolRequest } from '../../../src/agent/tools/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-user', phone_number: '+573000000001', timezone: 'America/Bogota' };
function context(capabilities = ['reminders.create', 'reminders.read', 'reminders.update', 'reminders.acknowledge']): TurnContext {
  return {
    userId: user.id, runId: 'fixture-run', requestId: 'fixture-request', timezone: 'America/Bogota',
    language: 'es', referenceTimeIso: '2026-10-11T17:49:00Z', capabilities: new Set(capabilities),
    signal: new AbortController().signal,
  };
}
const createInput = { content: 'Llamar a Ana', targetTimeIso: '2026-10-11T16:00:00-05:00' };
const record = { id, content: createInput.content, sendAt: '2026-10-11T21:00:00.000Z' };
const created = { success: true, action: 'created_reminders_batch', data: [record], confirmation: '⏰ Tarjeta existente' };

function setup(raw: unknown = created) {
  const execute = vi.fn<(request: LegacyToolRequest) => Promise<unknown>>().mockResolvedValue(raw);
  const tools = createReminderTools(createLegacyReminderPort(user, execute));
  return { execute, tools, registry: new ToolRegistry(tools) };
}

describe('atomic reminder contracts and capability scope', () => {
  it.each([
    { ...createInput, userId: 'another-user' }, { ...createInput, isPro: true },
    { ...createInput, replacePending: true }, { ...createInput, targetTimeIso: 'mañana a las 4' },
    { ...createInput, advanceMinutes: -1 }, { ...createInput, content: ' ' },
  ])('rejects invalid or authority-bearing arguments before dispatch: %j', async input => {
    const { registry, execute } = setup();
    expect((await registry.execute('reminder_create', input, context(), 'op-1')).status).toBe('validation_failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('advertises only permitted tools and checks permission again at execution', async () => {
    const { registry, execute } = setup();
    const capabilities = new Set(['reminders.read']);
    const ctx = { ...context(), capabilities };
    expect(registry.available(ctx).map(tool => tool.name)).toEqual(['reminder_read']);
    capabilities.clear();
    expect((await registry.execute('reminder_read', {}, ctx, 'op-1')).status).toBe('denied');
    expect((await registry.execute('missing_tool', {}, context(), 'op-1')).status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate names and isolates returned schema snapshots', () => {
    const { tools, registry } = setup();
    expect(() => new ToolRegistry([tools[0], tools[0]])).toThrow('Duplicate');
    const advertised = registry.available(context());
    const first = advertised[0];
    if (!first) throw new Error('Missing tool');
    first.inputSchema.extra = true;
    expect(registry.available(context())[0]?.inputSchema).not.toHaveProperty('extra');
    expect(first.inputSchema.properties).toHaveProperty('targetTimeIso');
    expect(first.inputSchema.properties).not.toHaveProperty('userId');
  });

  it('rejects owner mismatch, malformed context and cancellation before dispatch', async () => {
    const { registry, execute } = setup();
    expect(await registry.execute('reminder_create', createInput, { ...context(), userId: 'foreign-user' }, 'op-1')).toMatchObject({ status: 'denied', code: 'OWNER_MISMATCH' });
    expect(await registry.execute('reminder_create', createInput, { ...context(), referenceTimeIso: 'tomorrow' }, 'op-1')).toMatchObject({ status: 'validation_failed', code: 'INVALID_TURN_CONTEXT' });
    expect(await registry.execute('reminder_create', createInput, { ...context(), timezone: 'invalid-zone' }, 'op-1')).toMatchObject({ status: 'validation_failed', code: 'INVALID_TIMEZONE' });
    const controller = new AbortController(); controller.abort();
    expect(await registry.execute('reminder_create', createInput, { ...context(), signal: controller.signal }, 'op-1')).toMatchObject({ status: 'failed', code: 'CANCELLED' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('legacy execution mapping and verified outcomes', () => {
  it('passes trusted identity, time, language and policy to the existing executor once', async () => {
    const { registry, execute } = setup();
    const outcome = await registry.execute('reminder_create', { ...createInput, advanceMinutes: 15 },
      { ...context(), language: 'en', capabilities: new Set(['reminders.create', 'reminders.pro']) }, 'stable-op');
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      toolName: 'manage_reminder', params: { action: 'create', items: [{ content: createInput.content, advanceMinutes: 15, targetTime: record.sendAt }] },
      user: { ...user, locale: 'en-US' }, isPro: true, language: 'en', correlationId: 'fixture-request',
      referenceTime: new Date('2026-10-11T17:49:00Z'),
    });
    expect(outcome).toMatchObject({ status: 'success', receipt: { userId: user.id, operationId: 'stable-op', toolName: 'reminder_create', resourceIds: [id] } });
    if (!('data' in outcome)) throw new Error('Missing verified data');
    expect((outcome.data as ReminderResult).presentation.canonicalCard).toBe(created.confirmation);
  });

  it('preserves recurrence removal and advance-notice removal on updates', async () => {
    const { registry, execute } = setup({ success: true, action: 'updated_reminder', data: record });
    expect((await registry.execute('reminder_update', { reminderId: id }, context(), 'op-1')).status).toBe('validation_failed');
    expect((await registry.execute('reminder_update', { reminderId: id, recurrence: null, deliveryPolicy: { advanceNotice: 'none' } }, context(), 'op-1')).status).toBe('success');
    expect(execute.mock.calls[0]?.[0].params).toEqual({ action: 'update', target: id, updates: { recurrence: null }, deliveryPolicy: { advanceNotice: 'none' } });
  });

  it('acknowledges an observed UUID without falling back to textual target matching', async () => {
    const { registry, execute } = setup({ success: true, action: 'acknowledged_reminder', data: { ...record, acknowledged_at: '2026-10-11T21:05:00Z' } });
    expect((await registry.execute('reminder_acknowledge', { reminderId: id }, context(), 'op-1')).status).toBe('success');
    expect(execute.mock.calls[0]?.[0].params).toEqual({ action: 'acknowledge', reminderId: id });
  });

  it('retains confirmed principal effects when the advance notice fails', async () => {
    const { registry } = setup({
      success: true, action: 'partially_created_reminders', partialSuccess: true, complete: false,
      data: { items: [record], rejected: [{ code: 'DATABASE_ERROR', reason: 'El aviso previo no pudo guardarse.' }] },
      confirmation: '⏰ Principal creado; aviso pendiente',
    });
    const outcome = await registry.execute('reminder_create', createInput, context(), 'op-1');
    expect(outcome).toMatchObject({ status: 'partial', receipt: { resourceIds: [id] }, data: { complete: false, rejections: [{ code: 'DATABASE_ERROR' }] } });
  });

  it('preserves a failed update with known committed effects', async () => {
    const { registry } = setup({ success: false, action: 'delivery_policy_reconciliation_failed', partialSuccess: true, complete: false, data: { reminder: record } });
    expect(await registry.execute('reminder_update', { reminderId: id, content: 'Nuevo título' }, context(), 'op-1')).toMatchObject({ status: 'partial', receipt: { resourceIds: [id] }, data: { complete: false } });
  });

  it('keeps user clarification and Pro CTA data distinct from execution success', async () => {
    const { registry, execute } = setup({ success: false, action: 'reminder_clarification_required', errorCode: 'TIME_IN_PAST', requiresClarification: true, pendingClarifications: [{ question: '¿Mañana a las 4?' }], data: { items: [] } });
    const clarification = await registry.execute('reminder_create', createInput, context(), 'op-1');
    expect(clarification).toMatchObject({ status: 'clarification_required', data: { presentation: { questions: ['¿Mañana a las 4?'] } } });
    expect(JSON.parse(clarification.observation)).toMatchObject({ errorCode: 'TIME_IN_PAST', questions: ['¿Mañana a las 4?'] });
    execute.mockResolvedValueOnce({ success: false, action: 'pro_tier_required', errorCode: 'PRO_TIER_REQUIRED', ctaUrl: 'https://example.test/pro', ctaHeader: 'Pro', ctaButtonText: 'Ver Pro' });
    expect(await registry.execute('reminder_create', createInput, context(), 'op-2')).toMatchObject({ status: 'denied', data: { presentation: { cta: { url: 'https://example.test/pro', buttonText: 'Ver Pro' } } } });
  });

  it('bounds reads and strips raw database metadata from model observations', async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...record, id: `row-${index}`, user_id: user.id, phone_number: user.phone_number, secret: 'must-not-leak' }));
    const { registry } = setup({ success: true, action: 'listed_reminders', data: { reminders: rows } });
    const outcome = await registry.execute('reminder_read', {}, context(), 'op-1');
    expect(outcome).toMatchObject({ status: 'success', data: { coverage: 'bounded_list' } });
    const observation = JSON.parse(outcome.observation) as { returnedCount: number; shownCount: number; records: unknown[] };
    expect(observation).toMatchObject({ returnedCount: 50, shownCount: 5 });
    expect(observation.records).toHaveLength(5);
    expect(outcome.observation).not.toContain('must-not-leak');
    expect(outcome.observation).not.toContain('phone_number');
  });

  it.each(['*', '\0', ' '])('rejects unsafe literal reminder search %j', async query => {
    const { registry, execute } = setup();
    expect((await registry.execute('reminder_read', { query }, context(), 'op-1')).status).toBe('validation_failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('never retries unknown, thrown or malformed write outcomes', async () => {
    const { registry, execute } = setup({ success: false, action: 'error', outcome: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' });
    expect((await registry.execute('reminder_create', createInput, context(), 'op-1')).status).toBe('indeterminate');
    execute.mockRejectedValueOnce(new Error('secret-database-credentials'));
    const thrown = await registry.execute('reminder_create', createInput, context(), 'op-2');
    expect(thrown.status).toBe('indeterminate');
    expect(thrown.observation).not.toContain('secret');
    execute.mockResolvedValueOnce({ success: true, action: 'created_reminders_batch', data: [] });
    expect((await registry.execute('reminder_create', createInput, context(), 'op-3')).status).toBe('indeterminate');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('rejects forged receipt identity and malformed output without claiming success', async () => {
    const tool = defineTool({
      name: 'reminder_create', description: 'Synthetic invalid output', effect: 'write', requiredCapability: 'reminders.create',
      inputSchema: reminderCreateInputSchema, outputSchema: reminderResultSchema,
      handler: async () => ({ status: 'success', data: {} as ReminderResult, observation: 'not used',
        receipt: { userId: 'foreign-user', operationId: 'wrong', toolName: 'reminder_create', resourceIds: [] } }),
    });
    expect((await tool.execute(createInput, context(), 'op-1')).status).toBe('indeterminate');
  });
});
