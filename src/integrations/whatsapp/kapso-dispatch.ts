import type { JsonObject } from '@templelabs/contracts';
import { KapsoError, KapsoValidationError, KapsoAuthError, KapsoSandboxError, KapsoRateLimitError } from './kapso-errors.js';
const KAPSO_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
export interface KapsoPayload extends Record<string, unknown> {
  to?: string | null;
  recipient?: string | null;
  text?: { body?: string };
  interactive?: { body?: { text?: string } };
}
export interface KapsoDispatchInput { activePhoneId: string; apiKey: string; payload: KapsoPayload; fallbackText?: string | null }
export interface KapsoDispatchResult { success: true; messageId: string; recipientType: 'phone' | 'bsuid'; data: unknown }
export interface KapsoDispatchDependencies {
  assertTurnLease(): Promise<void>;
  checkpointTurnResponse(response: JsonObject): Promise<void>;
  currentTurnSignal(): AbortSignal | undefined;
  fetch: typeof fetch;
  markAsProcessed(messageId: string): void;
  sleep(milliseconds: number): Promise<void>;
  sendWhatsAppText(input: { phoneNumberId: string; phoneNumber: string | null | undefined; bsuid: string | null | undefined; text: string }): Promise<KapsoDispatchResult>;
}

export function createKapsoDispatch({ assertTurnLease, checkpointTurnResponse, currentTurnSignal, fetch, markAsProcessed, sleep, sendWhatsAppText }: KapsoDispatchDependencies) {
  async function postMessage({ activePhoneId, apiKey, payload, fallbackText = null }: KapsoDispatchInput): Promise<KapsoDispatchResult> {
    await assertTurnLease();
    const confirmation = payload.text?.body || payload.interactive?.body?.text;
    await checkpointTurnResponse({ ...(confirmation ? { confirmation } : {}), delivery: { status: 'attempted' } });
    for (let attempt = 0; ; attempt++) {
      await assertTurnLease();
      let response;
      try {
        const signals = [AbortSignal.timeout(15000), currentTurnSignal()].filter((signal): signal is AbortSignal => Boolean(signal));
        response = await fetch(`${KAPSO_API_BASE}/${activePhoneId}/messages`, {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.any(signals),
        });
      } catch {
        throw new KapsoError('Message delivery could not be confirmed.', { code: 'DELIVERY_OUTCOME_UNKNOWN' });
      }
      if (response.ok) {
        let data: unknown;
        try { data = await response.json(); } catch { /* A malformed receipt does not prove rejection. */ }
        const messageId = (data as { messages?: ({ id?: unknown } | null)[] | null } | null | undefined)?.messages?.[0]?.id;
        if (typeof messageId !== 'string' || !messageId.trim()) {
          throw new KapsoError('Provider response has no message identity.', { code: 'DELIVERY_OUTCOME_UNKNOWN' });
        }
        markAsProcessed(messageId);
        await checkpointTurnResponse({ delivery: { status: 'accepted', messageId } });
        return { success: true, messageId, recipientType: payload.recipient ? 'bsuid' : 'phone', data };
      }
      const status = response.status;
      const errText = await response.text().catch(() => '');
      // Only an explicit rejection can safely be retried or replaced by another format.
      if (status === 429 && attempt < 3) {
        await sleep(500 * 2 ** (attempt + 1));
        continue;
      }
      if ([400, 404, 422].includes(status)) {
        if (fallbackText) return sendWhatsAppText({
          phoneNumberId: activePhoneId, phoneNumber: payload.to, bsuid: payload.recipient, text: fallbackText,
        });
        throw new KapsoValidationError(`Kapso rejected the message (HTTP ${status}): ${errText.slice(0, 150)}`, status);
      }
      if (status === 401) throw new KapsoAuthError('Invalid or unauthorized KAPSO_API_KEY.');
      if (status === 403 && errText.includes('Active sandbox session required')) throw new KapsoSandboxError('Active sandbox session required.');
      if (status === 429) throw new KapsoRateLimitError('Kapso rate limit reached.');
      throw new KapsoError(`Message dispatch HTTP ${status}.`, {
        status, code: status >= 500 ? 'DELIVERY_OUTCOME_UNKNOWN' : 'DELIVERY_REJECTED', data: errText,
      });
    }
  }
  return { postMessage };
}
