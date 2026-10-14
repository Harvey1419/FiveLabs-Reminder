import { describe, it, expect, vi } from 'vitest';
import { createNextBestAction, type NextActionInput, type NextActionItem, type NextActionCompletion } from '../../../src/agent/orchestration/next-best-action-core.js';
function fixture() {
  const complete = vi.fn<NextActionCompletion>(async () => ({ content: '{"position":1,"suggestion":"  Continue the project.  "}' }));
  const format = vi.fn(() => 'local clock');
  const input: NextActionInput<NextActionItem> = {
    executionFacts: [{ tool: 'manage_task', requestedAction: 'complete', success: true, presentationData: { id: 'done' } }],
    dailyOverview: { openTasks: [{ id: 'next', title: 'Next step' }] },
    referenceTime: new Date('2026-10-12T12:00:00Z'),
  };
  return { complete, format, input, ...createNextBestAction({ complete, formatLocalDateTime: format }) };
}
describe('typed optional advice host boundary', () => {
  it('uses the per-call provider override and returns the original observed item without mutating it', async () => {
    const f = fixture(); const override = vi.fn<NextActionCompletion>(async () => ({ content: '{"position":1,"suggestion":" Next "}' }));
    const result = await f.resolveNextBestAction({ ...f.input, complete: override });
    expect(f.complete).not.toHaveBeenCalled(); expect(override).toHaveBeenCalledTimes(1);
    expect(result?.item).toBe(f.input.dailyOverview!.openTasks![0]); expect(result?.recommendationText).toBe('Next');
    expect(result?.item).toEqual({ id: 'next', title: 'Next step' });
    expect(override.mock.calls[0]![1]).toMatchObject({ tools: null, toolChoice: 'none', max_tokens: 1024, purpose: 'next_best_action', responseFormat: { type: 'json_schema', json_schema: { strict: true } } });
  });
  it.each([{ outcome: 'unknown' }, { complete: false }, { success: false }])('never asks the provider after uncertain or failed effects %j', async patch => {
    const f = fixture(); f.input.executionFacts = [{ ...f.input.executionFacts![0], ...patch }];
    expect(await f.resolveNextBestAction(f.input)).toBeNull(); expect(f.complete).not.toHaveBeenCalled(); expect(f.format).not.toHaveBeenCalled();
  });
  it('balances six sources, deduplicates within domains and excludes changed IDs across domains', async () => {
    const f = fixture(); const many = Array.from({ length: 20 }, (_, id) => ({ id: `old-${id}`, content: 'Follow-up' }));
    f.input.dailyOverview = { pendingConfirmationReminders: many, timedRemindersToday: [{ id: 'timed' }], tasksDueToday: [{ id: 'task' }], openTasks: [{ id: 'task' }, { id: 'done' }, { id: 'timed' }], tomorrowReminders: [{ id: 'tomorrow' }], tomorrowTasks: [{ internalId: 'later' }] };
    await f.resolveNextBestAction(f.input);
    const context = JSON.parse(f.complete.mock.calls[0]![0][1]!.content);
    expect(context.candidates).toHaveLength(12);
    expect(context.candidates.slice(0, 6).map((c: { type: string }) => c.type)).toEqual(['followup', 'reminder', 'task_due_today', 'open_task', 'tomorrow_reminder', 'tomorrow_task']);
    expect(context.candidates.every((c: object) => !('id' in c) && !('internalId' in c))).toBe(true);
  });
  it('bounds serialized context before inference', async () => {
    const f = fixture(); f.input.userText = 'x'.repeat(16001);
    expect(await f.resolveNextBestAction(f.input)).toBeNull(); expect(f.complete).not.toHaveBeenCalled();
  });
  it('formats valid timestamps with current turn locale and preserves observed fallback for invalid time', async () => {
    const f = fixture(); f.input.language = 'en'; f.input.timezone = 'Europe/London';
    f.input.dailyOverview = { openTasks: [{ id: 'next', due_date: '2026-10-12T14:00:00Z' }, { id: 'other', send_at: 'invalid', localFormatted: 'observed clock' }] };
    await f.resolveNextBestAction(f.input);
    expect(f.format).toHaveBeenCalledWith('2026-10-12T14:00:00Z', 'Europe/London', 'en-US');
    expect(JSON.parse(f.complete.mock.calls[0]![0][1]!.content).candidates[1].localTime).toBe('observed clock');
  });
  it.each([null, { unavailable: true, content: '{"position":1,"suggestion":"Advice"}' }, { content: '{"position":1,"suggestion":"' + 'x'.repeat(281) + '"}' }, { content: '{"position":1,"suggestion":"   "}' }])('drops unavailable and invalid decisions %j', async response => {
    const f = fixture(); f.complete.mockResolvedValue(response);
    expect(await f.resolveNextBestAction(f.input)).toBeNull(); expect(f.complete).toHaveBeenCalledTimes(1);
  });
  it('propagates host formatting failures before inference and never retries the provider', async () => {
    const f = fixture(); f.format.mockImplementation(() => { throw new Error('clock failed'); });
    await expect(f.resolveNextBestAction(f.input)).rejects.toThrow('clock failed'); expect(f.complete).not.toHaveBeenCalled();
    f.format.mockReturnValue('clock'); f.complete.mockRejectedValue(new Error('timeout'));
    expect(await f.resolveNextBestAction(f.input)).toBeNull(); expect(f.complete).toHaveBeenCalledTimes(1);
  });
});
