import { createRequire } from 'node:module';
import { IncomingMessage, ServerResponse, type RequestListener } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createGoogleCalendarWebhook, type CalendarWebhookResponse } from '../../../src/http/webhooks/google-calendar-handler.js';
interface TestApp extends RequestListener {
  post(path: string, handler: (req: IncomingMessage, res: CalendarWebhookResponse, next: (error?: unknown) => void) => void): void;
}
// Installed Express runtime with real Node request/response objects and an in-memory socket.
const express = createRequire(import.meta.url)('express') as () => TestApp;
function dispatch(app: TestApp, headers: IncomingMessage['headers']) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  // Node declares a TCP Socket; this offline fixture supplies its consumed stream operations.
  const requestSocket = socket as unknown as Socket;
  const req = new IncomingMessage(requestSocket); req.method = 'POST'; req.url = '/calendar'; req.headers = headers; req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
  const res = new ServerResponse(req); res.assignSocket(requestSocket);
  const finished = new Promise<void>((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  app(req, res);
  return { finished, res, socket, wire: () => Buffer.concat(chunks).toString('utf8') };
}
describe('actual Express Calendar webhook boundary', () => {
  it('returns the empty-body notification ACK while integration lookup is still pending, without network', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let reconciled = false;
    let work: Promise<unknown> | undefined;
    const { handleGoogleCalendarWebhook } = createGoogleCalendarWebhook({
      getUserIntegration: async () => { await pending; return { user_id: 'owner', metadata: { calendarSyncToken: 'sync' } }; },
      getUserIntegrationByChannelId: async () => null,
      listIncrementalCalendarEvents: async () => ({ items: [], nextSyncToken: 'next' }),
      updateUserIntegrationMetadata: async () => ({}),
      reconcileCalendarCompanionReminders: async () => { reconciled = true; },
      stopGoogleCalendarWatch: async () => true,
      getNow: () => new Date('2026-10-13T15:00:00Z'), logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const app = express();
    app.post('/calendar', (req, res, next) => { work = handleGoogleCalendarWebhook({ headers: req.headers }, res); void work.catch(next); });
    const invalid = dispatch(app, {});
    await invalid.finished; expect(invalid.res.statusCode).toBe(400); expect(invalid.wire()).toContain('Missing X-Goog-Channel-ID header'); invalid.socket.destroy();
    const ack = dispatch(app, { 'x-goog-channel-id': 'channel', 'x-goog-channel-token': 'userId=owner', 'x-goog-resource-state': 'exists' });
    try {
      await ack.finished; expect(ack.res.statusCode).toBe(200); expect(ack.wire()).toContain('HTTP/1.1 200 OK'); expect(ack.wire()).toContain('\r\n\r\nOK'); expect(reconciled).toBe(false); release(); await work; expect(reconciled).toBe(true);
    } finally { release(); await work; ack.socket.destroy(); }
  });
});
