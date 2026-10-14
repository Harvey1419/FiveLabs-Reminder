export interface HttpRequest { query: Readonly<Record<string, unknown>>; headers: Readonly<Record<string, string | undefined>>; rawBody?: Buffer }
export interface HttpResponse { status(code: number): HttpResponse; send(body: unknown): unknown; redirect(url: string): unknown; redirect(code: number, url: string): unknown; set(name: string, value: string): HttpResponse; json(body: unknown): unknown }
export type HttpHandler = (req: HttpRequest, res: HttpResponse) => unknown;
export interface GoogleAuthRouter { get(path: string, handler: HttpHandler): unknown }
export interface GoogleAuthDependencies {
  createRouter(): GoogleAuthRouter;
  generateGoogleAuthUrl(input: { userId: unknown; phoneNumber: unknown }): string;
  getOrCreateUserByPhone(phone: unknown): Promise<{ id: string }>;
  exchangeGoogleCode(code: unknown): Promise<{ tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null; scope?: string }; email?: string | null; name?: string | null }>;
  saveUserIntegration(userId: unknown, input: { provider: string; accessToken: string | null | undefined; refreshToken: string | null | undefined; tokenExpiry: Date | null; scopes: string[]; accountEmail: string | null | undefined; metadata: { displayName: string | null | undefined } }): Promise<unknown>;
  setupGoogleCalendarWatch(input: { userId: unknown }): Promise<unknown>;
  sendReminderConfirmation(phone: unknown, message: string): Promise<unknown>;
  saveMessage(input: { userId: unknown; phoneNumber: unknown; role: 'assistant'; content: string; intent: string; entities: Record<string, unknown> }): Promise<unknown>;
  renderGoogleSuccessPage(input: { email: unknown; theme: unknown }): string;
  getWhatsAppReturnUrl(): string;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
