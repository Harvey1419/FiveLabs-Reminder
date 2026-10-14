import { audioInputSchema, transcriptionAccountingSchema, type TranscriptionAccounting } from '@templelabs/contracts';
import { EndpointError } from '@templelabs/ai';
import type { TranscriptionProvider, TranscriptionRequest } from '@templelabs/ai';

/** User audio is decoded into text; execution/intent decisions still belong to the authenticated turn. */
export async function transcribeUserAudio(provider: TranscriptionProvider, request: TranscriptionRequest, now: () => number = Date.now) {
  const audio = audioInputSchema.parse(request.audio);
  const captured = { ...request, audio: { ...audio, bytes: Uint8Array.from(audio.bytes) } };
  const fresh = (accounting: TranscriptionAccounting = { status: 'unavailable' }) => {
    if (captured.signal.aborted) throw new EndpointError('ENDPOINT_ABORTED', accounting);
    const clock = now();
    if (!Number.isFinite(clock) || !Number.isFinite(captured.deadlineMs)) throw new EndpointError('INVALID_REQUEST', accounting);
    if (clock >= captured.deadlineMs) throw new EndpointError('ENDPOINT_DEADLINE', accounting);
  };
  fresh(); const result = await provider.transcribe(captured);
  const accounting = transcriptionAccountingSchema.parse(result.accounting); fresh(accounting);
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 100000) throw new EndpointError('INVALID_RESPONSE', accounting);
  return { text: result.text.trim(), accounting, grantsExecution: false as const };
}
