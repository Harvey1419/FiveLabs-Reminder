import { describe, expect, it } from 'vitest';
import { type AIResponse, productivityCheckpointSchema } from '@templelabs/contracts';
import { setup, context, reminderCreate, response } from '../../unit/agent-core/productivity-fixtures.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { boundWhatsAppText } from '../../../src/shared/whatsapp-text-boundary.js';

function publicReply(content: string): AIResponse {
  return { message: { role: 'assistant', content, toolCalls: [] }, stopReason: 'completed', usage: { inputTokens: 40, outputTokens: 25 } };
}
describe('V2 public conversation through durable execution and WhatsApp presentation', () => {
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
    expect(result.reply.text).toContain('Qué día largo.');
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
