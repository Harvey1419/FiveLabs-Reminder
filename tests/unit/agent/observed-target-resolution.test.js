import { describe, expect, it, vi } from 'vitest';
import { resolveObservedTarget } from '../../../src/agent/orchestration/resolve-observed-target.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';

vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
import { callChatCompletion } from '../../../src/agent/providers/client.js';

const candidates = [
  { id: 'fd49a320-c0d0-4c98-9022-f7bfc7ff9697', content: 'Review', send_at: '2031-01-14T12:00:00Z', recurrence_rule: 'weekly' },
  { id: '479d60f4-b263-4766-923c-93b8a15b83e0', content: 'Review', send_at: '2031-01-14T23:00:00Z', recurrence_rule: null },
];
const result = { success: false, errorCode: 'AMBIGUOUS_TARGET', requiresClarification: true, data: { reminders: candidates } };
const options = { toolName: 'manage_reminder', params: { action: 'cancel', target: 'Review at 7AM' }, result,
  userText: 'Cancel only the weekly review at 7AM; keep the 6PM one.', timezone: 'America/Bogota', language: 'en' };

describe('bounded resolution using tool observations', () => {
  it('binds only an observed identity and retains the exact authorized mutation', async () => {
    const complete = vi.fn().mockResolvedValue({ content: '{"position":1}' });
    const params = await resolveObservedTarget({ ...options, complete });
    expect(params).toEqual({ action: 'cancel', target: candidates[0].id, reminderId: candidates[0].id });
    expect(complete.mock.calls[0][0][1].content).toContain('weekly');
    expect(complete.mock.calls[0][0][1].content).not.toContain(candidates[0].id);
  });

  it.each(['{"position":0}', '{"position":3}', '{"position":1,"action":"delete"}', 'invalid'])('keeps clarification when the selection is unsafe: %s', async content => {
    expect(await resolveObservedTarget({ ...options, complete: vi.fn().mockResolvedValue({ content }) })).toBeNull();
  });

  it.each([{ outcome: 'unknown' }, { partialSuccess: true }, { success: true }, { errorCode: 'DATABASE_ERROR' }])('never repairs a possibly executed operation: %j', async delta => {
    const complete = vi.fn();
    expect(await resolveObservedTarget({ ...options, result: { ...result, ...delta }, complete })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('executes once after a read-only ambiguity result and records the bound identity', async () => {
    callChatCompletion.mockResolvedValue({ content: '{"position":1}' });
    const executeTool = vi.fn().mockResolvedValueOnce(result).mockResolvedValueOnce({ success: true, action: 'cancelled_reminder', data: { content: 'Review', cancelledCount: 1 } });
    const execution = await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'cancel', target: 'Review at 7AM' }] }, {
      user: { id: 'resolution-integration' }, userMessage: options.userText, language: 'en', timezone: 'America/Bogota', executeTool,
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[1][0].params.reminderId).toBe(candidates[0].id);
    expect(execution.facts).toHaveLength(1);
    expect(execution.facts[0]).toMatchObject({ success: true, presentationParams: { target: candidates[0].id } });
  });
});
