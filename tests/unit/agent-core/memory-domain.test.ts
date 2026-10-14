import { describe, expect, it, vi } from 'vitest';
import { memorySaveInputSchema, memoryRecordSchema, type MemoryRequest } from '@templelabs/contracts';
import { createMemoryDomainPort } from '../../../src/adapters/agent-core/memories-domain.js';
import { createNativeMemoryStore } from '../../../src/features/memory/native-store.js';
import { explicitMemoryIntent } from '../../../src/features/memory/explicit-intent.js';
import { nativeMemoryFixture, memoryId } from '../../support/unit/native-memory-fixture.js';
import { context, setup } from './productivity-fixtures.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
const text = 'Recuerda que vivo en Bogotá';
const content = 'vivo en Bogotá';
const request: MemoryRequest = { operation: 'save', input: { content, category: 'fact', evidenceStart: text.indexOf(content), evidenceEnd: text.length } };
function fixture() {
  const db = nativeMemoryFixture(), s = setup([]), admit = vi.fn(async () => true), embed = vi.fn(async () => null);
  const port = createMemoryDomainPort({ id: 'owner' }, text, { store: createNativeMemoryStore(db.client), admit, embed });
  return { ...db, ...s, admit, embed, port, run: (value = request) => withTurnLease(s.lease, () => port.execute(value, context, 'request:memory')) };
}
describe('explicit owned native memory operations', () => {
  it('saves grounded content once and reuses the exact structured identity without another insert or embedding', async () => {
    const f = fixture(); expect(await f.run()).toMatchObject({ status: 'success', data: { records: [{ id: memoryId, content, status: 'active' }] } });
    expect(await f.run()).toMatchObject({ status: 'success' });
    expect(f.calls.filter(call => call.operation === 'insert')).toHaveLength(1); expect(f.embed).toHaveBeenCalledOnce();
    expect(f.rows[0]?.user_id).toBe('owner'); expect(f.rows[0]?.topic_key).toMatch(/^explicit:/);
  });
  it('locates exact authored evidence without forcing the model to count offsets', async () => {
    const f = fixture(); expect(await f.run({ operation: 'save', input: { content, category: 'fact' } })).toMatchObject({ status: 'success' });
    expect(f.admit).toHaveBeenCalledWith(text, expect.objectContaining({ input: expect.objectContaining({ evidenceStart: text.indexOf(content), evidenceEnd: text.length }) }), expect.anything());
    expect(explicitMemoryIntent('🧠 Recuerda que vivo en Bogotá', 'save')).toBe(true);
    expect(explicitMemoryIntent('Uf, qué día largo. Recuerda que soy arquitecto.', 'save')).toBe(true);
    expect(explicitMemoryIntent('Quiero que recuerdes que vivo en Bogotá', 'save')).toBe(true);
  });
  it('rejects fabricated content before admission or database access', async () => {
    const f = fixture();
    expect(await f.run({ ...request, input: { ...request.input, content: 'Vivo en Tokio' } })).toMatchObject({ status: 'denied', code: 'MEMORY_EVIDENCE_MISMATCH' });
    expect(f.admit).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  });
  it('rejects semantic quotation/negation or operational state before persistence', async () => {
    const f = fixture(); f.admit.mockResolvedValue(false);
    expect(await f.run()).toMatchObject({ status: 'denied', code: 'MEMORY_NOT_ADMITTED' }); expect(f.calls).toHaveLength(0);
    f.admit.mockRejectedValue(new Error('admission unavailable'));
    expect(await f.run()).toMatchObject({ status: 'failed', code: 'MEMORY_ADMISSION_UNAVAILABLE' }); expect(f.calls).toHaveLength(0);
  });
  it('rechecks the lease after semantic admission and never inserts on lease loss', async () => {
    const f = fixture(); f.admit.mockImplementation(async () => { vi.mocked(f.lease.assertActive).mockRejectedValue(new Error('lease lost')); return true; });
    await expect(f.run()).rejects.toThrow('lease lost'); expect(f.calls).toHaveLength(0);
  });
  it('requires a durable owner-bound lease before any memory access', async () => {
    const f = fixture(); await expect(f.port.execute(request, context, 'op')).rejects.toThrow('lease');
    await expect(withTurnLease(f.lease, () => f.port.execute(request, { ...context, userId: 'foreign' }, 'op'))).rejects.toThrow('OWNER_MISMATCH');
    expect(f.calls).toHaveLength(0);
  });
  it('distinguishes a known failed read from a lost write receipt without automatic retries', async () => {
    const read = fixture(); read.failReads(); expect(await read.run()).toMatchObject({ status: 'failed' });
    expect(read.calls.some(call => call.operation === 'insert')).toBe(false);
    const unknown = fixture(); unknown.loseReceipt(); expect(await unknown.run()).toMatchObject({ status: 'indeterminate', operationId: 'request:memory' });
    expect(unknown.rows).toHaveLength(1); expect(unknown.calls.filter(call => call.operation === 'insert')).toHaveLength(1);
  });
  it('forgets only an active owned observed ID and returns the exact deletion receipt', async () => {
    const db = nativeMemoryFixture([{ id: memoryId, user_id: 'owner', content, category: 'fact', topic_key: 'profile:city', is_active: true },
      { id: '22222222-2222-4222-8222-222222222222', user_id: 'foreign', content: 'Private', category: 'fact', topic_key: null, is_active: true }]);
    const s = setup([]), port = createMemoryDomainPort({ id: 'owner' }, 'Olvida ese recuerdo', { store: createNativeMemoryStore(db.client), verifyForget: async () => true });
    const result = await withTurnLease(s.lease, () => port.execute({ operation: 'forget', input: { memoryId } }, context, 'forget'));
    expect(result).toMatchObject({ status: 'success', data: { records: [{ id: memoryId, status: 'forgotten' }] } });
    expect(db.rows).toHaveLength(1); expect(db.rows[0]?.user_id).toBe('foreign');
    expect(db.calls.find(call => call.operation === 'delete')?.filters).toEqual([['user_id', 'owner'], ['id', memoryId], ['is_active', true], ['content', content], ['category', 'fact']]);
  });
  it('bounds active owner-filtered reads and returns no embeddings or inactive memories', async () => {
    const db = nativeMemoryFixture(Array.from({ length: 8 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      user_id: index === 0 ? 'foreign' : 'owner', content: 'Memory ' + index, category: 'fact', topic_key: null, is_active: index !== 1, embedding: [99] })));
    const records = await createNativeMemoryStore(db.client).read(undefined, context);
    expect(records).toHaveLength(5); expect(records.every(record => memoryRecordSchema.safeParse(record).success)).toBe(true);
    expect(records.some(record => record.content === 'Memory 0' || record.content === 'Memory 1')).toBe(false);
    expect(JSON.stringify(records)).not.toContain('embedding'); expect(db.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects empty/invalid evidence spans at the atomic contract boundary', () => {
    expect(memorySaveInputSchema.safeParse({ ...request.input, evidenceEnd: request.input.evidenceStart }).success).toBe(false);
  });
  it.each(['Recuérdame pagar mañana', 'No guardes recuerdos', 'Delete the task', '"Remember my name"'])('does not authorize a memory mutation from %s', value => {
    expect(explicitMemoryIntent(value, 'save')).toBe(false); expect(explicitMemoryIntent(value, 'forget')).toBe(false);
  });
});
