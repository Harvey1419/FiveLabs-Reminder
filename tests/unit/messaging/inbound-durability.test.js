import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/infrastructure/database/inbound-turns.js', () => ({ enqueueInboundTurn: vi.fn() }));
import { enqueueInboundTurn } from '../../../src/infrastructure/database/inbound-turns.js';
import { handleWebhook } from '../../../src/http/webhooks/whatsapp.js';

const response = () => { const res = { status: vi.fn(() => res), send: vi.fn(() => res) }; return res; };
const request = () => ({ headers: {}, body: { message: { id: 'inbound-a', from: '19995550101', text: { body: 'Synthetic request' } } } });
beforeEach(() => { vi.clearAllMocks(); enqueueInboundTurn.mockReset(); });

describe('durable webhook acknowledgement', () => {
  it('waits for persistence before returning HTTP 200', async () => {
    let commit;
    enqueueInboundTurn.mockImplementation(() => new Promise(resolve => { commit = resolve; }));
    const res = response();
    const pending = handleWebhook(request(), res);
    expect(res.status).not.toHaveBeenCalled();
    commit({ inserted: true });
    await pending;
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it('returns a retryable response when storage cannot confirm the enqueue', async () => {
    enqueueInboundTurn.mockRejectedValue(new Error('Storage unavailable'));
    const res = response();
    await handleWebhook(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.status).not.toHaveBeenCalledWith(200);
  });
  it('persists every message in a Meta batch instead of silently dropping later messages', async () => {
    enqueueInboundTurn.mockResolvedValue({ inserted: true });
    const req = { headers: {}, body: { entry: [{ changes: [{ value: { messages: [
      { id: 'a', from: '19995550101', text: { body: 'First' } },
      { id: 'b', from: '19995550101', text: { body: 'Second' } },
    ] } }] }] } };
    const res = response();
    await handleWebhook(req, res);
    expect(enqueueInboundTurn.mock.calls.map(([turn]) => turn.messageId)).toEqual(['a', 'b']);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
