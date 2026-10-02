import { describe, expect, it, vi } from 'vitest';
import { resolveNextBestAction } from '../../../src/agent/orchestration/next-best-action.js';

const completed = { tool: 'manage_task', requestedAction: 'complete', action: 'completed_task', success: true, complete: true,
  presentationData: { id: 'done', title: 'Enviar reporte' } };
const options = { executionFacts: [completed], userText: 'Completé el reporte del proyecto', language: 'es',
  dailyOverview: { pendingConfirmationReminders: [{ id: 'old', content: 'Un seguimiento de otro proyecto', status: 'sent' }],
    openTasks: [{ id: 'next', title: 'Preparar presentación', entityName: 'Proyecto' }] } };
const answer = (position, suggestion) => vi.fn().mockResolvedValue({ content: JSON.stringify({ position, suggestion }) });

describe('grounded proactive decision after observed execution', () => {
  it('lets the model choose a relevant item instead of a fixed follow-up priority', async () => {
    const complete = answer(2, 'Puedes continuar con la presentación del proyecto.');
    const result = await resolveNextBestAction({ ...options, complete });
    expect(result).toMatchObject({ type: 'open_task', item: { id: 'next' }, recommendationText: 'Puedes continuar con la presentación del proyecto.' });
    expect(complete.mock.calls[0][1]).toMatchObject({ purpose: 'next_best_action', tools: null, toolChoice: 'none' });
    const evidence = JSON.parse(complete.mock.calls[0][0][1].content);
    expect(evidence.completed[0].data.id).toBe('done');
    expect(evidence.candidates).toHaveLength(2);
  });

  it('permits silence instead of forcing a recommendation', async () => {
    expect(await resolveNextBestAction({ ...options, complete: answer(0, '') })).toBeNull();
  });

  it('keeps every source represented when follow-ups exceed the context budget', async () => {
    const complete = answer(0, '');
    await resolveNextBestAction({ ...options, complete, dailyOverview: {
      pendingConfirmationReminders: Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}`, content: 'Old follow-up' })),
      tasksDueToday: [{ id: 'urgent', title: 'Send contract', due_date: '2026-10-02T20:00:00Z' }],
    }, referenceTime: new Date('2026-10-02T18:00:00Z'), timezone: 'America/Bogota', language: 'en' });
    const context = JSON.parse(complete.mock.calls[0][0][1].content);
    expect(context.candidates).toHaveLength(12);
    expect(context.candidates.find(item => item.title === 'Send contract').localTime).toContain('15:00');
    expect(context.localNow).toContain('13:00');
  });

  it.each([
    { executionFacts: [] }, { dailyOverview: null },
    { executionFacts: [{ ...completed, success: false }] },
    { executionFacts: [{ ...completed, complete: false }] },
    { executionFacts: [completed, { tool: 'manage_task', requestedAction: 'list', success: true }] },
  ])('does not ask for advice with missing evidence or an unresolved/read turn: %j', async change => {
    const complete = vi.fn();
    expect(await resolveNextBestAction({ ...options, ...change, complete })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('excludes completed/deleted items and refuses to infer an empty agenda', async () => {
    const complete = vi.fn();
    expect(await resolveNextBestAction({ ...options, dailyOverview: {
      openTasks: [{ id: 'done', title: 'Enviar reporte' }, { id: 'gone', status: 'deleted' }],
    }, complete })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('passes natural preferences and current request to the decision without a regex classifier', async () => {
    const complete = answer(0, '');
    await resolveNextBestAction({ ...options, user: { preferences: [{ content: 'Evita recomendarme más cosas al terminar.' }] }, complete });
    expect(JSON.parse(complete.mock.calls[0][0][1].content).preferences).toEqual(['Evita recomendarme más cosas al terminar.']);
  });

  it.each(['{"position":99,"suggestion":"Invented"}', '{"position":0,"suggestion":"Claim"}', '{"position":1,"suggestion":"Advice","actions":["delete"]}', 'bad'])('drops invalid selections: %s', async content => {
    expect(await resolveNextBestAction({ ...options, complete: vi.fn().mockResolvedValue({ content }) })).toBeNull();
  });

  it('degrades to no suggestion on provider failure', async () => {
    expect(await resolveNextBestAction({ ...options, complete: vi.fn().mockRejectedValue(new Error('timeout')) })).toBeNull();
  });

  it('uses the current turn language independently of the saved profile', async () => {
    const complete = answer(2, 'You could prepare the presentation next.');
    const result = await resolveNextBestAction({ ...options, user: { locale: 'es-CO' }, language: 'en', complete });
    expect(result.recommendationText).toBe('You could prepare the presentation next.');
    expect(complete.mock.calls[0][0][0].content).toContain('Respond in English');
  });
});
