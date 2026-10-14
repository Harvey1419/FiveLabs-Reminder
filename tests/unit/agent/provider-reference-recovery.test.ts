import { expect, it, vi } from 'vitest';
vi.mock('../../../src/infrastructure/database/agent-runs.js', () => ({ clearAgentRunsForUser: vi.fn() }));
import { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, formatWorkingMemoryPrompt } from '../../../src/agent/core/working-memory-store.js';
it('roundtrips fault diagnostics without exposing IDs or changing reference age', () => {
  const user = 'offline-fault-store';
  const timestamp = Date.now() - 1000;
  saveWorkingMemory(user, { source: 'task', infraFault: true, faultReason: 'schema_rejection', items: [{ id: 'private-id', title: 'Alpha' }] }, { restoredTimestamp: timestamp });
  expect(getWorkingMemory(user)).toMatchObject({ timestamp, infraFault: true, faultReason: 'schema_rejection' });
  expect(formatWorkingMemoryPrompt(user)).toContain('position:1');
  expect(formatWorkingMemoryPrompt(user)).not.toContain('private-id');
  clearWorkingMemory(user);
});
