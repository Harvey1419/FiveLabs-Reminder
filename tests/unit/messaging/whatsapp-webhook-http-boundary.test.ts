import { createRequire } from 'node:module';
import { IncomingMessage, ServerResponse, type RequestListener } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createWhatsAppWebhook } from '../../../src/http/webhooks/whatsapp-handler.js';
import type { WhatsAppRequest, WhatsAppResponse, WhatsAppWebhookDependencies } from '../../../src/http/webhooks/whatsapp-ports.js';
interface TestApp extends RequestListener { post(path: string, handler: (req: IncomingMessage & WhatsAppRequest, res: WhatsAppResponse, next: (error?: unknown) => void) => void): void }
const express = createRequire(import.meta.url)('express') as () => TestApp;
function dispatch(app: TestApp, request: WhatsAppRequest) {
  const chunks: Buffer[] = []; const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const requestSocket = socket as unknown as Socket;
  const req = new IncomingMessage(requestSocket); Object.assign(req, { method: 'POST', url: '/whatsapp', headers: {}, httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1 }, request);
  const res = new ServerResponse(req); res.assignSocket(requestSocket); const finished = new Promise<void>((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); }); app(req, res);
  return { finished, res, socket, wire: () => Buffer.concat(chunks).toString('utf8') };
}
function createIngress(enqueueInboundTurn: WhatsAppWebhookDependencies['enqueueInboundTurn']) {
  // Only ingress ports are exercised. An accidental dispatch would fail on absent dependencies.
  return createWhatsAppWebhook({ enqueueInboundTurn, normalizePhoneNumber: (raw: unknown) => typeof raw === 'string' ? raw : null, getEnv: () => ({}), getNowMs: () => 100, randomUUID: () => 'offline-http', logger: { error() {} } } as WhatsAppWebhookDependencies);
}
describe('real Express WhatsApp HTTP boundary without TCP', () => {
  it('holds the response open until inbox persistence completes', async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const webhook = createIngress(async () => { await pending; return {}; });
    const app = express(); let work: Promise<unknown> | undefined; app.post('/whatsapp', (req, res, next) => { work = webhook.handleWebhook(req, res); void work.catch(next); });
    const call = dispatch(app, { body: { message: { id: 'inbound', from: '573000000001', text: { body: 'Hello' } } } });
    try { expect(call.res.headersSent).toBe(false); expect(call.res.writableEnded).toBe(false); release(); await call.finished; await work; expect(call.res.statusCode).toBe(200); expect(call.wire()).toContain('HTTP/1.1 200 OK'); expect(call.wire()).toContain('\r\n\r\nOK'); } finally { release(); await work; call.socket.destroy(); }
  });
  it('returns a retryable 503 rather than a successful ACK when the inbox is unavailable', async () => {
    const webhook = createIngress(async () => { throw Error('synthetic unavailable'); }); const app = express(); let work: Promise<unknown> | undefined; app.post('/whatsapp', (req, res, next) => { work = webhook.handleWebhook(req, res); void work.catch(next); }); const call = dispatch(app, { body: { message: { id: 'inbound', from: '573000000001', text: { body: 'Hello' } } } });
    try { await call.finished; await work; expect(call.res.statusCode).toBe(503); expect(call.wire()).toContain('Temporarily unavailable'); } finally { call.socket.destroy(); }
  });
});
