import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { answerFromObservedReads } from '../../../src/agent/orchestration/observed-answer.js';
const input = { userText: 'Muéstrame la agenda', facts: [{ success: true, complete: true, callId: 'read1', presentationData: { tasks: [] } }], language: 'es' };
describe('observed answer composition', () => {
  it('leaves inventory rendering to the canonical card', async () => {
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'inventory', answer: '', evidenceCallIds: [] }) });
    expect(await answerFromObservedReads(input)).toBeNull();
  });
  it('discards inventory prose even if the model generates it', async () => {
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'inventory', answer: 'Tus tareas son...', evidenceCallIds: ['read1'] }) });
    expect(await answerFromObservedReads(input)).toBeNull();
  });
  it('requires real evidence for derived answers', async () => {
    callChatCompletion.mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: 'Total: 10', evidenceCallIds: [] }) });
    expect(await answerFromObservedReads(input)).toBeNull();
  });
});
