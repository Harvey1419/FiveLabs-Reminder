import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderRecord, ReminderUiItem, ReminderUiPayload } from '@templelabs/contracts';
import { WhatsAppCardPresenter } from '../../../src/presentation/whatsapp-card-presenter.js';

const main: ReminderRecord = {
  id: '11111111-1111-4111-8111-111111111111', content: 'Llamar a Ana', sendAt: '2026-10-11T21:00:00Z',
  recurrence: null, isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null,
};
function item(operation: 'create' | 'read' | 'update' | 'acknowledge', records = [main]): ReminderUiItem {
  return { callId: 'fixture-call', toolName: `reminder_${operation}`, status: 'success', code: null,
    readFilter: operation === 'read' ? 'today' : null, readQuery: null,
    result: { operation, records, complete: true, coverage: operation === 'read' ? 'bounded_list' : 'operation', rejections: [],
      presentation: { canonicalCard: 'INTERNAL legacy prose must never be copied', questions: [], cta: null } } };
}
function payload(items: ReminderUiItem[], language: 'es' | 'en' = 'es'): ReminderUiPayload {
  return { items, language, timezone: 'America/Bogota', notices: [] };
}
const presenter = new WhatsAppCardPresenter();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-11T17:49:00Z')); });
afterEach(() => vi.useRealTimers());

describe('deterministic WhatsApp reminder cards', () => {
  it.each(['es', 'en'] as const)('preserves canonical single creation style in %s', language => {
    expect(presenter.render(payload([item('create')], language))).toMatchSnapshot();
  });

  it('aggregates multiple creations and deduplicates the same observed resource', () => {
    const second = { ...main, id: '22222222-2222-4222-8222-222222222222', content: 'Enviar propuesta', sendAt: '2026-10-11T22:00:00Z' };
    const rendered = presenter.render(payload([item('create'), item('create'), item('create', [second])]));
    expect(rendered).toMatchSnapshot();
    expect(rendered.text.match(/Llamar a Ana/g)).toHaveLength(1);
    expect(rendered.text).not.toContain('INTERNAL');
  });

  it('pairs same-title advance notices with their parent identities', () => {
    const second = { ...main, id: '22222222-2222-4222-8222-222222222222', sendAt: '2026-10-11T23:00:00Z' };
    const advance1 = { ...main, id: '33333333-3333-4333-8333-333333333333', isAdvanceNotice: true, parentReminderId: main.id, sendAt: '2026-10-11T20:45:00Z' };
    const advance2 = { ...advance1, id: '44444444-4444-4444-8444-444444444444', parentReminderId: second.id, sendAt: '2026-10-11T22:45:00Z' };
    expect(presenter.render(payload([item('create', [main, second, advance2, advance1])]))).toMatchSnapshot();
  });

  it('keeps recurrence, partial effects and clarification visible together', () => {
    const partial = item('create', [{ ...main, recurrence: 'weekly' }]);
    partial.status = 'partial';
    if (!partial.result) throw new Error('Missing result');
    partial.result.complete = false;
    const clarification = item('create', []);
    clarification.status = 'clarification_required';
    if (!clarification.result) throw new Error('Missing result');
    clarification.result.complete = false;
    clarification.result.presentation.questions = ['¿A qué hora quieres el segundo recordatorio?'];
    expect(presenter.render(payload([partial, clarification]))).toMatchSnapshot();
  });

  it('preserves read, update and confirmation cards', () => {
    expect(['read', 'update', 'acknowledge'].map(operation => presenter.render(payload([item(operation as 'read' | 'update' | 'acknowledge')])))).toMatchSnapshot();
  });

  it('preserves clarification attached to a partially completed operation', () => {
    const partial = item('create');
    partial.status = 'partial';
    if (!partial.result) throw new Error('Missing result');
    partial.result.complete = false;
    partial.result.presentation.questions = ['¿A qué hora quieres el aviso previo?'];
    const rendered = presenter.render(payload([partial]));
    expect(rendered.text).toContain('Recordatorio programado');
    expect(rendered.text).toContain('¿A qué hora quieres el aviso previo?');
  });

  it('does not replace an unknown outcome with a successful card from attached data', () => {
    const unknown = { ...item('create'), status: 'indeterminate' as const };
    const rendered = presenter.render(payload([unknown]));
    expect(rendered).toMatchSnapshot();
    expect(rendered.text).not.toContain('Recordatorio programado');
  });

  it('keeps Pro CTA separate, deduplicated and restricted to HTTPS', () => {
    const denied = item('create', []);
    denied.status = 'denied'; denied.code = 'PRO_TIER_REQUIRED';
    if (!denied.result) throw new Error('Missing result');
    denied.result.presentation.cta = { url: 'https://example.test/pro', header: 'Pro', buttonText: 'Ver Pro' };
    expect(presenter.render(payload([denied, denied]))).toEqual({ text: '✨ Este recordatorio necesita Pro.', ctas: [denied.result.presentation.cta] });
    denied.result.presentation.cta.url = 'javascript:bad';
    expect(presenter.render(payload([denied])).ctas).toEqual([]);
  });

  it('rejects an operation mismatch and keeps no-action prompts deterministic', () => {
    const mismatch = { ...item('create'), toolName: 'reminder_update' as const };
    expect(() => presenter.render(payload([mismatch]))).toThrow('operation mismatch');
    expect(presenter.render(payload([])).text).toBe('¿Qué recordatorio quieres crear, consultar o cambiar?');
  });
});
