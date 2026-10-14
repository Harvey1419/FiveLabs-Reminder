import { describe, expect, it, vi } from 'vitest';
import { readPriorInboundTurn, type InboundStoredTurn } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import type { TurnContext } from '@templelabs/contracts';
const context: TurnContext = { userId: 'owner', runId: 'current', requestId: 'current-message', language: 'es', timezone: 'America/Bogota', referenceTimeIso: '2026-10-14T12:00:00Z', capabilities: new Set(), signal: new AbortController().signal };
function row(id: string, sequence_id: number, status: InboundStoredTurn['status'], response: InboundStoredTurn['response'] = {}): InboundStoredTurn {
  return { id, message_id: id + '-message', thread_id: 'thread', sequence_id, status, response };
}
function fixture(prior: InboundStoredTurn[]) {
  const anchor = { ...row('current', 100, 'running'), message_id: 'current-message' };
  const rows = [anchor, ...prior];
  const client = { from: () => ({ select: () => {
    const eqs = new Map<string, string>(); let before = Infinity; let statuses: string[] = [];
    const query = { eq: (key: string, value: string) => { eqs.set(key, value); return query; },
      lt: (_key: string, value: number) => { before = value; return query; },
      in: (_key: string, value: string[]) => { statuses = value; return query; },
      order: () => query, limit: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ data: rows.filter(row => row.sequence_id < before && [...eqs].every(([key, value]) => row[key as keyof InboundStoredTurn] === value)
        && (!statuses.length || statuses.includes(row.status))).sort((a, b) => b.sequence_id - a.sequence_id)[0] ?? null, error: null }) };
    return query;
  } }) };
  const lease = { inboundTurn: { id: 'current', messageId: 'current-message', threadId: 'thread', response: {} }, signal: context.signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const onUnknown = vi.fn((): never => { throw new Error('uncertain prior'); });
  return { onUnknown, run: () => withTurnLease(lease, () => readPriorInboundTurn(client, context, 'thread', onUnknown)) };
}
describe('admission failures do not quarantine effect-free future turns', () => {
  it('skips a lease-resolved rejected delivery while preserving the last actual conversation', async () => {
    const rejected = row('rejected', 95, 'completed', { delivery: { status: 'attempted' }, agentCoreTransportRejected: {
      version: 1, userId: 'owner', runId: 'rejected', requestId: 'rejected-message', threadId: 'thread', effects: 'read_only', delivery: 'rejected',
      sourceFingerprint: 'a'.repeat(64), leaseOwnerId: '11111111-1111-4111-8111-111111111111', resolvedAtUtc: '2026-10-14T15:00:00Z',
      rejection: { source: 'railway_provider_error_log', provider: 'Kapso', httpStatus: 400, providerCode: 100,
        message: 'Param text.body must be at most 4096 characters long.', correlationId: '11111111-1111-4111-8111-111111111111', loggedAtUtc: '2026-10-13T03:47:16Z' },
    } });
    const actual = row('actual', 80, 'completed', { agentCoreProductivity: { phase: 'completed' } });
    expect(await fixture([rejected, actual]).run()).toEqual(actual);
    await expect(fixture([{ ...rejected, status: 'unknown' }, actual]).run()).rejects.toThrow('uncertain prior');
    const foreign = structuredClone(rejected);
    const certificate = foreign.response!.agentCoreTransportRejected;
    if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate)) throw new Error('Missing fixture certificate');
    certificate.userId = 'foreign';
    expect(await fixture([foreign, actual]).run()).toEqual(foreign);
  });
  it.each([null, {}])('skips the old audio rejection with response %s and its empty cascade while preserving the last actual conversation', async response => {
    const first = { ...row('bc23fc5d', 90, 'unknown', response), last_error: 'PRIOR_TURN_RECONCILIATION_REQUIRED' };
    const cascade = { ...row('805f2116', 95, 'unknown'), last_error: 'PRIOR_TURN_RECONCILIATION_REQUIRED' };
    const actual = row('actual', 80, 'completed', { agentCoreProductivity: { phase: 'completed' } });
    const f = fixture([first, cascade, actual]); expect(await f.run()).toEqual(actual); expect(f.onUnknown).not.toHaveBeenCalled();
  });
  it('skips a certified new terminal rejection without minting an empty replacement conversation', async () => {
    const rejected = row('rejected', 95, 'completed', { agentCoreAdmissionRejected: { version: 1, runId: 'rejected', requestId: 'rejected-message', threadId: 'thread', userId: 'owner', phase: 'rejected_before_engine', effects: 'none', reason: 'V2_UNSUPPORTED_INPUT' } });
    const actual = row('actual', 80, 'completed', { confirmation: 'Actual conversation' });
    expect(await fixture([rejected, actual]).run()).toEqual(actual);
  });
  it.each(['WORKER_LEASE_EXPIRED', 'REPLY_DELIVERY_UNKNOWN', 'PROCESSING_INTERRUPTED', undefined])('never skips an empty unknown with error %s', async last_error => {
    const f = fixture([{ ...row('unsafe', 90, 'unknown'), ...(last_error ? { last_error } : {}) }]);
    await expect(f.run()).rejects.toThrow('uncertain prior'); expect(f.onUnknown).toHaveBeenCalledOnce();
  });
  it('never skips the gate error if an execution or delivery namespace is present', async () => {
    const f = fixture([{ ...row('unsafe', 90, 'unknown', { agentCoreProductivity: { effects: [] } }), last_error: 'PRIOR_TURN_RECONCILIATION_REQUIRED' }]);
    await expect(f.run()).rejects.toThrow('uncertain prior');
  });
  it('still finds an older unsafe unknown beneath later harmless rejections', async () => {
    const f = fixture([{ ...row('harmless', 95, 'unknown'), last_error: 'PRIOR_TURN_RECONCILIATION_REQUIRED' }, row('unsafe', 80, 'unknown')]);
    await expect(f.run()).rejects.toThrow('uncertain prior'); expect(f.onUnknown).toHaveBeenCalledWith(expect.objectContaining({ id: 'unsafe' }));
  });
  it('rejects forged owner identity on a no-effects certificate', async () => {
    const f = fixture([row('bad', 90, 'unknown', { agentCoreAdmissionRejected: { version: 1, runId: 'bad', requestId: 'bad-message', threadId: 'thread', userId: 'foreign', phase: 'rejected_before_engine', effects: 'none', reason: 'V2_UNSUPPORTED_INPUT' } })]);
    await expect(f.run()).rejects.toThrow('uncertain prior');
  });
});
