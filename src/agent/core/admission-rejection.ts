import { z } from 'zod';
import type { InboundTurnLease } from './turn-lease.js';

// Private host classification shared by source/emitted loaders. Error codes alone never certify no effects.
const key = Symbol.for('templelabs.hermes.admission-rejection.v1');
const host = globalThis as typeof globalThis & { [key]?: WeakSet<object> };
const rejected = host[key] ?? new WeakSet<object>();
if (!host[key]) Object.defineProperty(host, key, { value: rejected });
export const admissionRejectionSchema = z.strictObject({ version: z.literal(1), runId: z.string().min(1),
  requestId: z.string().min(1), threadId: z.string().min(1), userId: z.string().min(1),
  phase: z.literal('rejected_before_engine'), effects: z.literal('none'), reason: z.string().min(1).max(100) });
export async function rejectBeforeEngine(lease: InboundTurnLease, userId: string, reason: string): Promise<never> {
  if (Object.keys(lease.inboundTurn.response).length) throw new Error('Cannot certify a previously started turn');
  lease.signal.throwIfAborted();
  await lease.assertActive();
  await lease.checkpoint({ agentCoreAdmissionRejected: admissionRejectionSchema.parse({ version: 1,
    runId: lease.inboundTurn.id, requestId: lease.inboundTurn.messageId, threadId: lease.inboundTurn.threadId,
    userId, phase: 'rejected_before_engine', effects: 'none', reason }) });
  const error = Object.assign(new Error(reason), { code: reason });
  rejected.add(error);
  throw error;
}
export function isAdmissionRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && rejected.has(error);
}
