/** Consumed integration/event fields; adapters retain the original provider objects. */
export interface CalendarWatchMetadata extends Record<string, unknown> {
  channelId?: string | null;
  resourceId?: string | null;
  channelExpiration?: unknown;
  calendarSyncToken?: string | null;
}
export interface CalendarWatchIntegration {
  user_id: string;
  metadata?: CalendarWatchMetadata | null;
}
export interface CalendarWatchEvent extends Record<string, unknown> {
  id?: string | null;
  status?: string | null;
}
export interface CalendarDelta {
  nextSyncToken?: string | null;
  fullSync?: unknown;
  items?: (CalendarWatchEvent | null | undefined)[] | null;
}
export interface CalendarReconciliationInput {
  userId: string;
  notifyOnDiscovery: boolean;
  notifyEventIds?: string[];
  cancelledEventIds?: string[];
  extraEvents?: CalendarWatchEvent[];
}
export interface CalendarWatchPorts {
  listIncrementalCalendarEvents(userId: string, options?: { syncToken: string }): Promise<CalendarDelta | null | undefined>;
  updateUserIntegrationMetadata(userId: string, provider: 'google', metadata: Record<string, unknown>): Promise<unknown>;
  reconcileCalendarCompanionReminders(input: CalendarReconciliationInput): Promise<unknown>;
  stopGoogleCalendarWatch(input: { userId: string; channelId: string; resourceId: string }): Promise<unknown>;
  getNow(): Date;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
