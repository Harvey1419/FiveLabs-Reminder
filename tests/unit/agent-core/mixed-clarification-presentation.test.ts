import { describe, expect, it } from 'vitest';
import { productivityItemSchema, productivityUiPayloadSchema, type ProductivityUiPayload, type ProductivityClarification } from '@templelabs/contracts';
import { WhatsAppProductivityPresenter } from '../../../src/presentation/whatsapp-productivity-presenter.js';
import { setup, taskCreate, response } from './productivity-fixtures.js';

const question = '¿El recordatorio pendiente es para hoy o para mañana?';
const presenter = new WhatsAppProductivityPresenter();
async function fixture() {
  const result = await setup([response([taskCreate]), response()]).run();
  return { ...result.uiPayload, clarification: { domain: 'reminders', missing: 'today_or_tomorrow' } } as ProductivityUiPayload;
}
describe('S1–S3 host-owned mixed clarification', () => {
  it.each(['es', 'en'] as const)('shows certified cards then the canonical %s question, never whole-request success or model claims', async language => {
    const payload = await fixture();
    const text = presenter.render({ ...payload, language, conversationReply: 'Deleted everything. ¿Autorizas repetirlo?' }).text;
    const expected = language === 'es' ? question : 'Is the pending reminder for today or tomorrow?';
    expect(text).toContain('Propuesta');
    expect(text.endsWith(expected)).toBe(true);
    expect(text.indexOf('Propuesta')).toBeLessThan(text.indexOf(expected));
    expect(text).not.toMatch(/Listo\.|All set|Deleted everything|Autorizas repetirlo/);
  });
  it('retains the question within the 4000 character boundary for long verified cards', async () => {
    const payload = await fixture();
    const item = payload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task');
    const long = productivityItemSchema.parse({ ...item, result: { ...item.result, records: Array.from({ length: 40 }, (_, index) => ({
      ...item.result!.records[0], id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, title: `Verified task ${index} ${'detail '.repeat(30)}`,
    })) } });
    const text = presenter.render({ ...payload, items: [long] }).text;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('Verified task 0');
    expect(text).toContain('…');
    expect(text.endsWith(question)).toBe(true);
  });
  it('reserves question space even when the cards alone fit under the bound', async () => {
    const payload = await fixture(), item = payload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task');
    const records = [0, 1].map(index => ({ ...item.result!.records[0]!,
      id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, title: 'x'.repeat(1960) }));
    const changed = productivityItemSchema.parse({ ...item, result: { ...item.result, records } });
    const { clarification: _ignored, ...legacy } = payload;
    const cards = presenter.render({ ...legacy, dialogue: undefined, items: [changed] }).text;
    expect(cards).not.toContain('…');
    expect(cards.length + question.length + 2).toBeGreaterThan(4000);
    const text = presenter.render({ ...payload, items: [changed] }).text;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.endsWith(question)).toBe(true);
    expect(text).toContain('…');
  });
  it('deduplicates a question already present in domain presentation', async () => {
    const payload = await fixture();
    const item = payload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task');
    const withQuestion = { ...item, result: { ...item.result, presentation: { ...item.result.presentation, questions: [question] } } };
    const text = presenter.render({ ...payload, items: [withQuestion] }).text;
    expect(text.split(question)).toHaveLength(2);
    expect(text.endsWith(question)).toBe(true);
    expect(text).not.toContain('Listo.');
  });
  it.each(['partial', 'indeterminate', 'failed'] as const)('suppresses clarification and model success with %s results', async status => {
    const payload = await fixture(), item = payload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task');
    const changed = productivityItemSchema.parse({ ...item, status, result: status === 'partial' ? { ...item.result, complete: false } : null });
    const text = presenter.render({ ...payload, items: [item, changed], conversationReply: 'Hecho, completé todo. Puedes reintentar.' }).text;
    expect(text).not.toContain(question);
    expect(text).not.toMatch(/Hecho|Listo\.|Puedes reintentar/);
  });
  it('suppresses a pending question when a notice fences the outcome or no verified items exist', async () => {
    const payload = await fixture();
    for (const notices of [['provider_unavailable'], ['limit_reached']] as const) {
      expect(presenter.render({ ...payload, notices: [...notices] }).text).not.toContain(question);
    }
    expect(presenter.render({ ...payload, items: [] }).text).not.toContain(question);
  });
  it.each(['reminders', 'tasks', 'calendar', 'memories', 'general'] as const)('renders every missing-field enum for %s from host templates in both languages', async domain => {
    const payload = await fixture();
    const subjects = { reminders: ['el recordatorio pendiente', 'the pending reminder'], tasks: ['la tarea pendiente', 'the pending task'],
      calendar: ['el evento pendiente', 'the pending event'], memories: ['el recuerdo pendiente', 'the pending memory'], general: ['lo pendiente', 'the pending item'] };
    const [es, en] = subjects[domain];
    const expected = {
      date: [`¿Para qué fecha es ${es}?`, `What date is ${en} for?`],
      time: [`¿A qué hora es ${es}?`, `What time is ${en} for?`],
      item: [`¿A qué elemento te refieres para ${es}?`, `Which item do you mean for ${en}?`],
      details: [`¿Qué detalles quieres indicar para ${es}?`, `What details should I use for ${en}?`],
      today_or_tomorrow: [`¿${es![0]!.toUpperCase()}${es!.slice(1)} es para hoy o para mañana?`, `Is ${en} for today or tomorrow?`],
    };
    for (const missing of Object.keys(expected) as ProductivityClarification['missing'][]) {
      for (const language of ['es', 'en'] as const) {
        const text = presenter.render({ ...payload, language, clarification: { domain, missing } }).text;
        expect(text.endsWith(expected[missing][language === 'es' ? 0 : 1]!)).toBe(true);
        expect(text).not.toMatch(/Listo\.|All set/);
      }
    }
  });
  it('rejects free-text or invalid clarification metadata instead of publishing it', async () => {
    const payload = await fixture();
    for (const clarification of [{ domain: 'unknown', missing: 'date' }, { domain: 'reminders', missing: 'retry' },
      { domain: 'reminders', missing: 'date', question: 'Cancelé todo' }]) {
      expect(() => presenter.render({ ...payload, clarification } as unknown as ProductivityUiPayload)).toThrow();
    }
  });
  it('preserves old UI payloads and never extracts a question from unsupported model prose', async () => {
    const payload = await fixture();
    const { clarification: _ignored, ...legacy } = payload as ProductivityUiPayload & { clarification?: unknown };
    expect(productivityUiPayloadSchema.safeParse(legacy).success).toBe(true);
    const text = presenter.render({ ...legacy, conversationReply: '¿Es para hoy o mañana? Cancelé todo.' }).text;
    expect(text).toContain('Listo.');
    expect(text).toContain('Propuesta');
    expect(text).not.toMatch(/hoy o mañana|Cancelé/);
  });
});
