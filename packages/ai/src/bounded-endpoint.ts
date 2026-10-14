import { transcriptionAccountingSchema, type TranscriptionAccounting } from '@templelabs/contracts';
export class EndpointError extends Error {
  readonly accounting: TranscriptionAccounting;
  constructor(readonly code: 'INVALID_REQUEST' | 'MISSING_CREDENTIALS' | 'ENDPOINT_ABORTED' | 'ENDPOINT_DEADLINE' | 'ENDPOINT_FAILED' | 'INVALID_RESPONSE', accounting: TranscriptionAccounting = { status: 'unavailable' }) {
    super(code); this.name = 'EndpointError';
    this.accounting = Object.freeze(transcriptionAccountingSchema.parse(accounting));
  }
}
export function assertEndpointFresh(deadlineMs: number, signal: AbortSignal, now: () => number): void {
  if (signal.aborted) throw new EndpointError('ENDPOINT_ABORTED');
  const clock = now();
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(clock)) throw new EndpointError('INVALID_REQUEST');
  if (clock >= deadlineMs) throw new EndpointError('ENDPOINT_DEADLINE');
}
/** Single explicit attempt, bounded through body decoding even when the transport ignores its signal. */
export async function boundedEndpoint(endpoint: string, init: RequestInit, deadlineMs: number, signal: AbortSignal,
  timeoutMs: number, fetch: typeof globalThis.fetch, now: () => number): Promise<{ response: Response; raw: unknown }> {
  assertEndpointFresh(deadlineMs, signal, now);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, Math.max(1, deadlineMs - now()), 2147483647));
  let onAbort: () => void = () => {};
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(new EndpointError(signal.aborted ? 'ENDPOINT_ABORTED' : 'ENDPOINT_DEADLINE'));
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) { onAbort(); return; }
      Promise.resolve().then(async () => {
        combined.throwIfAborted();
        const response = await fetch(endpoint, { ...init, signal: combined });
        const raw: unknown = await response.json();
        return { response, raw };
      }).then(resolve, () => reject(new EndpointError('ENDPOINT_FAILED')));
    });
  } finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); }
}
