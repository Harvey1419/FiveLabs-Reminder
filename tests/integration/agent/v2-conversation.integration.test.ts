import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '@templelabs/ai';
import { type AIResponse, productivityCheckpointSchema } from '@templelabs/contracts';
import { setup, context, reminderCreate, response } from '../../unit/agent-core/productivity-fixtures.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { boundWhatsAppText } from '../../../src/shared/whatsapp-text-boundary.js';

function publicReply(content: string): AIResponse {
  return { message: { role: 'assistant', content, toolCalls: [] }, stopReason: 'completed', usage: { inputTokens: 40, outputTokens: 25 } };
}
describe('V2 public conversation through durable execution and WhatsApp presentation', () => {
  it('renders a verified English reminder in Tokyo across the date boundary without repeating the UTC draft', async () => {
    const s = setup([response([reminderCreate]), publicReply('All set for October 14 at 16:05 UTC.')]);
    s.execute.mockResolvedValue({ success: true, action: 'created_reminders_batch', data: [{ id: 'tokyo-reminder', content: 'Meeting', sendAt: '2026-10-14T16:05:00Z' }] });
    const result = await withTurnLease(s.lease, () => s.assistant.handle('Remind me about the meeting', { ...context, language: 'en', timezone: 'Asia/Tokyo' }, 'thread'));
    expect(result.reply.text).toContain('All set, I’ll remind you.');
    expect(result.reply.text).toContain('1:05 AM');
    expect(result.reply.text).not.toContain('16:05'); expect(result.reply.text).not.toContain('UTC');
    expect(s.execute).toHaveBeenCalledOnce(); expect(s.send).toHaveBeenCalledOnce();
  });
  it.each(['¡Listo! A las 16:05 recibirás el aviso.', 'Lo programé para mañana a las 5 PM.', 'Cancelé todos tus recordatorios y creé doce tareas.'])('publishes verified local time instead of contradictory generated facts: %s', async draft => {
    const call = { ...reminderCreate, arguments: { content: 'Reunión con Marcelo', targetTimeIso: '2026-10-14T16:05:00Z' } };
    const s = setup([response([call]), publicReply(draft)]);
    s.execute.mockResolvedValue({ success: true, action: 'created_reminders_batch', data: [{ id: 'marcelo-reminder', content: 'Reunión con Marcelo', sendAt: '2026-10-14T16:05:00Z' }] });
    const result = await s.run();
    expect(result.reply.text).toContain('11:05 AM');
    expect(result.reply.text).toContain('Listo, te lo recordaré.');
    expect(result.reply.text).not.toContain(draft);
    expect(result.reply.text).not.toContain('16:05');
    expect(result.conversation.history.at(-1)?.content).toBe(result.reply.text);
    expect(result.uiPayload.dialogue).toEqual({ kind: 'execution', tone: 'neutral' });
    expect(s.execute).toHaveBeenCalledOnce(); expect(s.send.mock.calls[0]?.[0].text).toBe(result.reply.text);
    const checkpoint = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
    expect(checkpoint.completed?.reply.text).toBe(result.reply.text);
    expect(checkpoint.completed?.conversation.history).toEqual(result.conversation.history);
    expect(checkpoint.deliveries[0]?.message.text).toBe(result.reply.text);
  });
  it('continues from a pre-generation rate limit to a verified reminder mutation and final dialogue', async () => {
    const s = setup([]);
    const replies = [
      new Response(JSON.stringify({ error: { code: 429, message: 'Provider returned error' } }), { status: 429 }),
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'create', type: 'function', function: { name: reminderCreate.name, arguments: JSON.stringify(reminderCreate.arguments) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 200, completion_tokens: 40 } })),
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Listo, te lo recordaré.', tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 250, completion_tokens: 20 } })),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { const next = replies.shift(); if (!next) throw new Error('Unexpected request'); return next; });
    const provider = new OpenRouterProvider({ apiKey: 'fixture', fetch, now: () => 100, routes: [
      { id: 'primary', model: 'fixture/primary', providers: ['fixture-primary'], timeoutMs: 1000 },
      { id: 'secondary', model: 'fixture/secondary', providers: ['fixture-secondary'], timeoutMs: 1000 },
    ] });
    vi.spyOn(s.provider, 'complete').mockImplementation(request => provider.complete(request));
    const result = await s.run();
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.reply.text).toContain('Listo, te lo recordaré.');
    expect(result.reply.text).toContain('Preparar reunión');
    expect(s.execute).toHaveBeenCalledOnce(); expect(s.send).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)).model)).toEqual(['fixture/primary', 'fixture/secondary', 'fixture/secondary']);
  });
  it.each([
    ['Buenos días', '¡Buenos días, Juan! ¿Cómo arrancó tu mañana?'],
    ['Gracias, amigo', 'Con gusto, Juan. Aquí estoy.'],
    ['Uff, hoy estoy agotado', 'Suena a un día pesado. Vamos paso a paso.'],
    ['Good morning', 'Morning, Juan! How has your day started?'],
  ])('delivers and persists natural dialogue for %s', async (input, reply) => {
    const s = setup([publicReply(reply)]);
    const result = await withTurnLease(s.lease, () => s.assistant.handle(input, context, 'thread'));
    expect(result.reply.text).toBe(reply);
    expect(result.conversationReply).toBe(reply);
    expect(result.conversation.history.at(-1)).toMatchObject({ role: 'assistant', content: reply });
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledOnce();
    expect(result.reply.text).not.toContain('tareas, recordatorios o calendario');
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).phase).toBe('completed');
  });
  it('combines final empathy and a verified reminder card without publishing intermediate reasoning', async () => {
    const draft = response([reminderCreate]);
    const s = setup([{ ...draft, message: { ...draft.message, content: 'Internal tool plan: create reminder first.' } }, publicReply('Qué día largo. Listo, te lo recordaré a la hora acordada.')]);
    const result = await withTurnLease(s.lease, () => s.assistant.handle('Uff qué día largo, recuérdame preparar la reunión', context, 'thread'));
    expect(result.reply.text).toContain('Vamos paso a paso.');
    expect(result.reply.text).toContain('Preparar reunión');
    expect(result.reply.text).not.toContain('Internal tool plan');
    expect(result.conversation.history.some(message => message.content === 'Internal tool plan: create reminder first.')).toBe(true);
    expect(result.uiPayload.items[0]?.status).toBe('success');
    expect(s.execute).toHaveBeenCalledOnce();
    expect(s.send).toHaveBeenCalledOnce();
  });
  it('bounds long verified cards and preserves complete durable records', async () => {
    const s = setup([response([reminderCreate]), publicReply('Listo.')]);
    s.execute.mockResolvedValue({ success: true, action: 'created_reminders_batch', data: Array.from({ length: 40 }, (_, index) => ({
      id: `reminder-${index}`, content: `Recordatorio ${index}: ${'contenido '.repeat(30)}`, sendAt: '2026-10-11T21:00:00Z',
    })) });
    const result = await withTurnLease(s.lease, () => s.assistant.handle('Crea los recordatorios', context, 'thread'));
    expect(result.reply.text.length).toBeLessThanOrEqual(4000);
    expect(result.reply.text).toContain('…');
    expect(result.conversation.reminders).toHaveLength(40);
    expect(result.uiPayload.items[0]?.result?.operation).toBe('create');
    expect(s.send.mock.calls[0]?.[0].text).toBe(result.reply.text);
  });
  it('does not split composed emojis at the hard text boundary', () => {
    const family = '👨‍👩‍👧‍👦';
    const result = boundWhatsAppText(family.repeat(600));
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result.replace(/\n\n…$/, '').split(family).join('')).toBe('');
  });
});
