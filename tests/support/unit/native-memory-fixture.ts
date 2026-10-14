import { vi } from 'vitest';
import type { NativeMemoryClient, NativeMemoryQuery } from '../../../src/features/memory/native-store.js';
export const memoryId = '11111111-1111-4111-8111-111111111111';
export function nativeMemoryFixture(seed: Record<string, unknown>[] = []) {
  const rows = structuredClone(seed);
  const calls: { operation: string; filters: [string, unknown][]; projection: string; signal?: AbortSignal }[] = [];
  let loseWriteReceipt = false;
  let failReads = false;
  const client: NativeMemoryClient = { from: vi.fn(() => {
    const filters = new Map<string, unknown>(); let operation = 'read'; let payload: unknown; let count = 50;
    let projection = ''; let signal: AbortSignal | undefined; let search: string | undefined;
    const materialize = () => {
      calls.push({ operation, filters: [...filters], projection, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (operation === 'read' && failReads) return { data: null, error: { code: 'fixture_read_error' } };
      let selected = rows.filter(row => [...filters].every(([key, value]) => row[key] === value));
      if (search) selected = selected.filter(row => String(row.content).toLowerCase().includes(search!.slice(1, -1).replace(/\\([\\%_])/g, '$1').toLowerCase()));
      if (operation === 'insert') {
        const value = payload as Record<string, unknown>;
        const created = { ...value, id: memoryId, created_at: '2026-10-14T12:00:00Z' };
        rows.push(created); selected = [created];
      }
      if (operation === 'delete') for (const row of selected) rows.splice(rows.indexOf(row), 1);
      if (operation !== 'read' && loseWriteReceipt) return { data: null, error: { code: 'receipt_lost' } };
      return { data: structuredClone(selected.slice(0, count)), error: null };
    };
    const query: NativeMemoryQuery = {
      select: value => { projection = value; return query; },
      insert: value => { operation = 'insert'; payload = value; return query; },
      delete: () => { operation = 'delete'; return query; },
      eq: (key, value) => { filters.set(key, value); return query; },
      ilike: (_key, value) => { search = value; return query; },
      order: () => query, limit: value => { count = value; return query; },
      abortSignal: value => { signal = value; return query; },
      maybeSingle: async () => { const result = materialize(); return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }; },
      then: (resolve, reject) => Promise.resolve().then(materialize).then(resolve, reject),
    };
    return query;
  }) };
  return { client, rows, calls, loseReceipt: () => { loseWriteReceipt = true; }, failReads: () => { failReads = true; } };
}
