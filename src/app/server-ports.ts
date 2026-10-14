import type { HttpHandler, HttpRequest, GoogleAuthRouter } from '../http/routes/google-auth-ports.js';
export interface ExpressApp {
  use(...args: unknown[]): unknown;
  get(path: string | string[], handler: HttpHandler): unknown;
  post(path: string, handler: unknown): unknown;
  listen(port: string | number, callback: () => void): { close(): unknown };
}
export interface ShutdownTimer { unref(): unknown }
export interface ServerDependencies {
  createApp(): ExpressApp;
  staticMiddleware(path: string): unknown;
  jsonMiddleware(options: { limit: string; verify(req: HttpRequest, res: unknown, buf: Buffer): void }): unknown;
  googleAuthRouter: GoogleAuthRouter;
  handleWebhook: unknown; handleStripeWebhook: unknown; handleGoogleCalendarWebhook: unknown;
  processWebhookMessage(request: unknown): Promise<unknown>;
  assertInboundQueueReady(): Promise<unknown>;
  startInboundTurnWorker(processTurn: ServerDependencies['processWebhookMessage']): { stop(): Promise<void> };
  buildStripeCheckoutUrl(input: { userId: unknown; language: unknown }): string;
  renderSubscriptionSuccessPage(input: { theme: unknown }): string;
  renderPrivacyPolicyPage(): string; renderTermsOfServicePage(): string; renderHomePage(): string;
  startScheduler(): Promise<unknown>; startMorningBriefingWorker(): unknown; startCalendarWatchWorker(): unknown;
  getEnv(): NodeJS.ProcessEnv;
  once(signal: 'SIGTERM' | 'SIGINT', callback: () => Promise<void>): unknown;
  exit(code: number): unknown;
  setTimeout(callback: () => unknown, ms: number): ShutdownTimer;
  clearTimeout(timer: ShutdownTimer): void;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
