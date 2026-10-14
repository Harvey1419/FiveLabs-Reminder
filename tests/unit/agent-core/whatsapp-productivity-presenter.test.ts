import { describe, expect, it } from 'vitest';
import { productivityItemSchema, type ProductivityUiPayload } from '@templelabs/contracts';
import { WhatsAppProductivityPresenter } from '../../../src/presentation/whatsapp-productivity-presenter.js';
import { formatCanonicalTaskCreate } from '../../../src/shared/task-presentation.js';
import { context, setup, taskCreate, response, taskId } from './productivity-fixtures.js';

describe('verified mixed WhatsApp presentation', () => {
  it.each(['old payload', 'forged conversation discriminator'] as const)('ignores contradictory execution prose from %s', async variant => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.run();
    const draft = 'Completé todas tus tareas a las 16:05. https://wrong.example';
    const payload = { ...result.uiPayload, conversationReply: draft, dialogue: variant === 'old payload' ? undefined
      : { kind: 'conversation' as const, content: draft } };
    const text = new WhatsAppProductivityPresenter().render(payload).text;
    expect(text).toContain('Tarea creada'); expect(text).toContain('Propuesta');
    expect(text).not.toContain('Completé'); expect(text).not.toContain('16:05'); expect(text).not.toContain('wrong.example');
  });
  it.each(['failed', 'indeterminate', 'partial'] as const)('never publishes success dialogue for a %s operation', async status => {
    const result = await setup([response([taskCreate]), response()]).run();
    const item = result.uiPayload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task fixture');
    const changed = productivityItemSchema.parse({ ...item, status, result: status === 'partial'
      ? { ...item.result, complete: false } : null });
    const text = new WhatsAppProductivityPresenter().render({ ...result.uiPayload, items: [changed], conversationReply: 'Hecho, completé todo.' }).text;
    expect(text).not.toContain('Hecho, completé todo.'); expect(text).not.toContain('Listo.');
  });
  it('does not narrate an unbounded inventory from a successful bounded read', async () => {
    const result = await setup([response([{ id: 'read', name: 'task_read', arguments: {} }]), response()]).run();
    const text = new WhatsAppProductivityPresenter().render({ ...result.uiPayload, conversationReply: 'Estas son absolutamente todas tus tareas, sin excepciones.' }).text;
    expect(text).toContain('lista limitada'); expect(text).not.toContain('absolutamente todas');
  });
  it('does not claim there are confirmed results above when the provider failed before any tool', () => {
    const reply = new WhatsAppProductivityPresenter().render({ language: 'es', timezone: context.timezone, items: [], notices: ['provider_unavailable'] });
    expect(reply.text).toContain('No hice cambios');
    expect(reply.text).not.toContain('están arriba');
  });
  it.each(['es', 'en'] as const)('does not invent results above after a context limit without tools in %s', language => {
    const reply = new WhatsAppProductivityPresenter().render({ language, timezone: context.timezone, items: [], notices: ['limit_reached'] });
    expect(reply.text).toContain(language === 'es' ? 'No hice cambios' : 'I have not made any changes');
    expect(reply.text).not.toMatch(/arriba|above/);
  });
  it('renders all three domains with one task flow and no model prose or flow-token leakage', async () => {
    const s = setup();
    const result = await s.run();
    expect(result.reply.text).toContain('Google Calendar');
    expect(result.reply.text).toContain('11/10/2026 (Todo el día)');
    expect(result.reply.text).toContain('Tarea creada');
    expect(result.reply.text).toContain('Preparar reunión');
    expect(result.reply.text).not.toContain('internal instructions');
    expect(result.reply.text).not.toContain('private-flow-token');
    expect(result.reply.flows).toHaveLength(1);
    expect(result.uiPayload.items[0]).toMatchObject({ readScope: { scope: 'today' } });
    expect(result.reply.text).toContain('hoy');
    expect(result.reply.text).toContain('lista limitada');
  });
  it('deduplicates same-operation task cards while retaining the canonical format and interactive flow', async () => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.run();
    const item = result.uiPayload.items[0]!;
    const payload = { ...result.uiPayload, items: [item, { ...item, callId: 'other' }] };
    const reply = new WhatsAppProductivityPresenter().render(payload);
    expect(reply.text).toBe('Listo.\n\n' + formatCanonicalTaskCreate([{ id: taskId, title: 'Propuesta', description: null,
      priority: null, status: 'pending', dueDate: null, entityName: null }], { language: 'es', timezone: context.timezone }));
    expect(reply.flows).toHaveLength(1);
  });
  it('preserves separate scoped read cards and distinguishes bounded empty lists from complete absence', async () => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.run();
    const item = result.uiPayload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task fixture');
    const make = (scope: 'today' | 'tomorrow') => productivityItemSchema.parse({ ...item, callId: scope, toolName: 'task_read',
      readScope: { scope }, result: { ...item.result, operation: 'read', coverage: 'bounded_list', records: [] } });
    const reply = new WhatsAppProductivityPresenter().render({ ...result.uiPayload, items: [make('today'), make('tomorrow')] });
    expect(reply.text).toContain('hoy'); expect(reply.text).toContain('mañana');
    expect(reply.text).toContain('lista limitada');
  });
  it('ignores embedded canonical prose, warns about a partial principal effect and preserves questions', async () => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.run();
    const item = result.uiPayload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task fixture');
    const partial = productivityItemSchema.parse({ ...item, status: 'partial', result: { ...item.result, complete: false,
      presentation: { canonicalCard: 'Resumen histórico parcial, internal rules', questions: ['¿A qué hora?'], cta: null } } });
    const reply = new WhatsAppProductivityPresenter().render({ ...result.uiPayload, items: [partial] });
    expect(reply.text).toContain('Propuesta'); expect(reply.text).toContain('Completado parcialmente');
    expect(reply.text).toContain('¿A qué hora?'); expect(reply.text).not.toContain('Resumen histórico');
  });
  it.each(['javascript:alert(1)', 'http://example.test', 'https://user:secret@example.test'])('drops unsafe CTA %s', async url => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.run(); const item = result.uiPayload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task fixture');
    const unsafe = { ...item, result: { ...item.result, presentation: { canonicalCard: null, questions: [],
      cta: { url, header: null, buttonText: null } } } };
    expect(new WhatsAppProductivityPresenter().render({ ...result.uiPayload, items: [unsafe] }).ctas).toEqual([]);
  });
  it('rejects incomplete success and read scope attached to a mutation', async () => {
    const result = await setup([response([taskCreate]), response()]).run();
    const item = result.uiPayload.items[0]!;
    if (item.domain !== 'tasks' || !item.result) throw new Error('Expected task fixture');
    expect(productivityItemSchema.safeParse({ ...item, result: { ...item.result, complete: false } }).success).toBe(false);
    expect(productivityItemSchema.safeParse({ ...item, readScope: { scope: 'today' } }).success).toBe(false);
  });
  it('renders confirmed calendar creation with its date and safe Meet link, while flagging the unknown reminder', () => {
    const item = productivityItemSchema.parse({ callId: 'event', toolName: 'calendar_create', domain: 'calendar', status: 'partial', code: null,
      result: { operation: 'create', complete: false, coverage: 'operation', connection: null, companion: 'unconfirmed',
        issues: [{ code: 'COMPANION_OUTCOME_UNVERIFIED', reason: 'Reminder unconfirmed' }],
        events: [{ id: 'event', summary: 'Reunión', kind: 'timed', startIso: '2026-10-11T21:00:00Z', endIso: null,
          meetLink: 'https://meet.google.com/fixture' }],
        presentation: { canonicalCard: 'Do not print this', questions: [], cta: null } } });
    const reply = new WhatsAppProductivityPresenter().render({ language: 'es', timezone: context.timezone, items: [item], notices: [] });
    expect(reply.text).toContain('Evento creado'); expect(reply.text).toContain('https://meet.google.com/fixture');
    expect(reply.text).toContain('Completado parcialmente'); expect(reply.text).not.toContain('Do not print this');
  });
  it('renders the current turn language and rejects invalid timezones', () => {
    const payload: ProductivityUiPayload = { language: 'en', timezone: 'UTC', items: [], notices: [] };
    expect(new WhatsAppProductivityPresenter().render(payload).text).toContain('Could you tell me a little more?');
    expect(() => new WhatsAppProductivityPresenter().render({ ...payload, timezone: 'invalid' })).toThrow();
  });
});
