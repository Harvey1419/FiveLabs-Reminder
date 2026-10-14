import type { BackgroundMemoryInput } from '../../jobs/memory-extraction-queue.js';
/** Consumed fields only. Unknown provider extras remain on the original JSON objects. */
export type WhatsAppText = string | { body?: string };
export interface WhatsAppReply { id?: string; title?: string }
export interface WhatsAppInteractive extends WhatsAppReply {
  type?: string; nfm_reply?: { response_json?: string | { selected_ids?: unknown; selected_tasks?: unknown }; responseJson?: string }; response_json?: string; responseJson?: string;
  button_reply?: WhatsAppReply; list_reply?: WhatsAppReply;
}
export interface WhatsAppMedia { id?: string; caption?: string; media_url?: string; url?: string; download_url?: string; link?: string; mime_type?: string }
export interface WhatsAppMessage extends Record<string, unknown> {
  id?: string; from?: string; from_user_id?: string; username?: string; timestamp?: string | number;
  direction?: string; from_me?: boolean; kapso?: { direction?: string; origin?: string; status?: string };
  text?: WhatsAppText; interactive?: WhatsAppInteractive; button_reply?: WhatsAppReply; list_reply?: WhatsAppReply;
  caption?: string; image?: WhatsAppMedia; audio?: WhatsAppMedia; document?: WhatsAppMedia; type?: string; media_url?: string;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  context?: { quoted_content?: string; body?: string; text?: string; message?: { text?: WhatsAppText } };
  phone_number_id?: string;
}
export interface WhatsAppStatus extends Record<string, unknown> { id?: string; status?: string; errors?: unknown; error?: unknown }
export interface WhatsAppConversation { phone_number_id?: string; phone_number?: string; business_scoped_user_id?: string; contact_name?: string }
export interface WhatsAppValue extends Record<string, unknown> {
  phone_number_id?: string; metadata?: { phone_number_id?: string }; messages?: WhatsAppMessage[]; statuses?: WhatsAppStatus[];
  contacts?: { wa_id?: string; user_id?: string; profile?: { name?: string } }[];
}
export interface WhatsAppChange extends Record<string, unknown> { value?: WhatsAppValue }
export interface WhatsAppEntry extends Record<string, unknown> { changes?: WhatsAppChange[] }
export interface WhatsAppPayload extends WhatsAppMessage {
  message?: WhatsAppMessage; entry?: WhatsAppEntry[]; conversation?: WhatsAppConversation;
  data?: { id?: string; text?: string; phone_number_id?: string; message?: WhatsAppMessage; conversation?: WhatsAppConversation };
  phone_number?: string; statuses?: WhatsAppStatus[]; status?: unknown;
}
export interface WhatsAppRequest { body?: WhatsAppPayload; headers?: Readonly<Record<string, unknown>>; receivedAt?: number }
export interface WhatsAppResponse { status(code: number): WhatsAppResponse; send(body: string): unknown }
export interface WhatsAppUser extends Record<string, unknown> { id: string; phone_number?: string | null; locale?: string | null }
export interface WhatsAppDomainRow extends Record<string, unknown> { id?: string; task_id?: string | null; recurrence_rule?: string | null; status?: string; title?: string; content?: string; send_at?: string | number | Date | null }
export interface WhatsAppTaskResult extends WhatsAppDomainRow { data?: WhatsAppDomainRow | null }
export interface WhatsAppRouteResult {
  confirmation?: string | null; intent?: string; entities?: Record<string, unknown> | null; executionFacts?: unknown[]; language?: string;
  flow?: { headerText?: string; footerText?: string; buttonText?: string; flowId?: string; flowToken?: string; flowAction?: string; screen?: string; data?: Record<string, unknown>; mode?: string };
  ctaUrl?: string; ctaHeader?: string; ctaButtonText?: string;
  buttons?: import('../../integrations/whatsapp/kapso-client-core.js').KapsoButton[]; buttonsHeader?: string; buttonsFooter?: string;
  list?: { sections?: { title?: unknown; rows?: import('../../integrations/whatsapp/kapso-client-core.js').KapsoListRow[] }[]; headerText?: string; footerText?: string; buttonText?: string };
  memoryDisposition?: string; learningCandidates?: unknown[]; learningCandidatesProvided?: boolean;
}
export interface WhatsAppSendInput { phoneNumberId: string; phoneNumber: string | null; bsuid: string | null; text?: string; bodyText?: string; [key: string]: unknown }
export interface WhatsAppDelivery { success: boolean; messageId?: string | null }
export interface WhatsAppWebhookDependencies {
  enqueueInboundTurn(input: { messageId: string; threadId: string; request: { body: WhatsAppPayload; headers: Record<string, unknown>; receivedAt: number } }): Promise<unknown>;
  assertTurnLease(): Promise<void>;
  checkpointTurnResponse(response: Record<string, unknown>): Promise<void>;
  withoutTurnLease<T>(work: () => T): T;
  clearWorkingMemory(key: unknown): unknown;
  routeMessage(text: string, user: WhatsAppUser, history: unknown[], options: { correlationId: unknown; requestTimeMs: number; inputModality: string; attachmentOnly: boolean; currentUserText: string; agentCoreMedia?: import('@templelabs/contracts').TurnMediaInput; agentCoreAuthorizeWrite?: import('@templelabs/agent-core').AgentLoopOptions['authorizeWrite']; agentCoreDelivery?: import('../../adapters/agent-core/durable-productivity-assistant.js').ProductivityDeliveryPort }): Promise<WhatsAppRouteResult>;
  sendWhatsAppText(input: WhatsAppSendInput): Promise<WhatsAppDelivery>;
  sendWhatsAppCtaUrl(input: WhatsAppSendInput): Promise<WhatsAppDelivery>;
  sendWhatsAppFlow(input: WhatsAppSendInput): Promise<WhatsAppDelivery>;
  sendWhatsAppQuickReplyButtons(input: WhatsAppSendInput): Promise<WhatsAppDelivery>;
  sendWhatsAppListMessage(input: WhatsAppSendInput): Promise<WhatsAppDelivery>;
  sendTypingIndicator(messageId: string, phoneNumberId: string): Promise<unknown>;
  downloadMedia(mediaId: string | undefined, phoneNumberId: string, directUrl?: string | null): Promise<Blob | null>;
  normalizePhoneNumber(input: unknown): string | null;
  saveMessage(input: { userId: string; phoneNumber: string; role: 'user' | 'assistant'; content: string; messageId?: string | null; intent?: string | undefined; entities: Record<string, unknown> }): Promise<unknown>;
  getRecentMessages(phone: string, limit: number): Promise<{ role?: string; entities?: { _responseLanguage?: string } }[]>;
  isMessageAlreadyProcessed(id: string): Promise<boolean>;
  getAssistantMessageById(id: string): Promise<unknown>;
  getOrCreateUserByPhone(phone: string, timezone: null, locale: string, displayName: string | null, options: { fresh: true }): Promise<WhatsAppUser | null>;
  touchUserLastActive(userId: string, phone: string): unknown;
  updateReminderDeliveryStatus(status: { deliveryId: string; deliveryStatus: string; errorDetails: unknown }): Promise<unknown>;
  acknowledgeReminder(id: string, userId: string): Promise<WhatsAppDomainRow | null>;
  acknowledgeRemindersByTaskId(taskId: string, userId: string): Promise<{ error?: unknown } | null>;
  updateReminder(id: string, updates: Record<string, unknown>, userId: string, phone: string | null | undefined): Promise<WhatsAppDomainRow | null>;
  updateTask(taskId: unknown, updates: { status: 'completed' }, userId: string): Promise<WhatsAppTaskResult | null>;
  extractMemoryInBackground(input: BackgroundMemoryInput): unknown;
  withQueryEmbeddingScope<T>(userId: string, work: () => T): T;
  transcribeAudio(blob: Blob, mimeType: string, options: { language: string }): Promise<string | null>;
  processDocumentOrImage(blob: Blob, mimeType: string, caption: string): Promise<string | null>;
  getNearestCityFromCoordinates: typeof import('../../shared/time.js').getNearestCityFromCoordinates;
  extractCurrentUserText: typeof import('../../shared/current-user-input.js').extractCurrentUserText;
  isIntradayRecurrence(rule: string | null | undefined): boolean;
  getEnv(): NodeJS.ProcessEnv; getNow(): Date; getNowMs(): number; randomUUID(): string;
  setTimeout(callback: () => unknown, ms: number): { unref?(): unknown };
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
