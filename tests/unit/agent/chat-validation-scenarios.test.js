import { expect, it } from 'vitest';
import { CHAT_VALIDATION_SCENARIOS, getValidationTurns } from '../../../scripts/dev/chat-validation-scenarios.js';

it('preserves existing safe bounded scenario selections', () => {
  const full = getValidationTurns('full');
  expect(full).toHaveLength(30);
  expect(getValidationTurns('final-cases')).toEqual([full[9], full[4], ...full.slice(-7)]);
  expect(getValidationTurns('summary-cases')).toEqual([full[9], full[4], 'Resume lo que hicimos: qué tarea y recordatorio creaste y cuál es su estado actual.']);
  expect(full[4]).toContain('2031');
});
it('adds assistant-quality fixtures without importing the live app or DB', () => {
  expect(CHAT_VALIDATION_SCENARIOS).toContain('assistant-cases');
  const turns = getValidationTurns('assistant-cases');
  expect(turns).toHaveLength(17);
  expect(turns.every(turn => typeof turn === 'string' && !turn.includes('\n'))).toBe(true);
  expect(turns[2]).toContain('Si me mudara');
  expect(turns[6]).toContain('ahora prefiero mensajes de texto');
  expect(turns[13]).toContain('pending tasks');
  expect(turns[16]).toContain('summarize');
  expect(turns[4]).toContain('no te estoy pidiendo cambiar de idioma');
});
it('revalidates critical closure cases without replaying already proven setup', () => {
  const assistant = getValidationTurns('assistant-cases');
  expect(getValidationTurns('closure-cases')).toEqual([0, 4, 5, 6, 8, 10, 12, 13, 15, 16].map(index => assistant[index]));
  expect(getValidationTurns('closure-cases')).toHaveLength(10);
});
it('covers invalid-reference recovery and real creation proof within the existing runner', () => {
  const turns = getValidationTurns('recovery-cases');
  expect(turns).toHaveLength(13);
  expect(turns[2]).toBe(getValidationTurns('full')[6]);
  expect(turns[7]).toContain('tarea 99');
  expect(turns[8]).toBe(getValidationTurns('full')[16]);
  expect(turns.at(-1)).toContain('Resume lo que hicimos');
});
it('returns independent fixture arrays and rejects unsupported scenarios', () => {
  getValidationTurns('assistant-cases').pop();
  expect(getValidationTurns('assistant-cases')).toHaveLength(17);
  expect(() => getValidationTurns('unknown')).toThrow('Unsupported chat validation scenario');
});
