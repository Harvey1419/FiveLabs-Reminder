/** Narrow provider ports avoid coupling runtime code to the entire Google SDK type graph. */
export interface GoogleEventTime { date?: string | null | undefined; dateTime?: string | null | undefined; timeZone?: string }
export interface GoogleEventFields extends Record<string, unknown> {
 id?: string | null; summary?: string | null; description?: string | null; location?: string | null;
 status?: string | null; htmlLink?: string | null;
 hangoutLink?: string | null; recurringEventId?: string | null; recurrence?: string[];
 conferenceData?: { entryPoints?: { uri?: string | null }[]; createRequest?: { requestId: string; conferenceSolutionKey: { type: string } } } | null;
 attendees?: { email?: string | null }[] | null;
}
export interface GoogleEvent extends GoogleEventFields { start?: GoogleEventTime | null; end?: GoogleEventTime | null }
export interface CalendarEventInput extends GoogleEventFields {
 start?: GoogleEventTime | string | null; end?: GoogleEventTime | string | null;
 rawStartDate?: string | null; rawStartDateTime?: string | null; isAllDay?: boolean; meetLink?: string | null;
}
export interface CalendarListOptions { timeMin?: string | Date; timeMax?: string | Date | null; maxResults?: number; timezone?: string; q?: unknown }
export interface CalendarWriteInput { eventId?: string; summary?: string; description?: string | null;
 startDateTime?: string | Date; endDateTime?: string | Date | null; timezone?: string; addGoogleMeet?: boolean;
 customEventId?: string | null; allDay?: boolean; startDate?: string | null; endDate?: string | null;
 recurrence?: unknown; clearRecurrence?: boolean; durationMinutes?: unknown }
export interface CalendarDeltaOptions { syncToken?: string | null; timezone?: string; timeMin?: string | Date | null; timeMax?: string | Date | null }
export interface WatchInput { userId?: string | undefined; webhookUrl?: string | null; channelId?: string | null; resourceId?: string | null; ttlSeconds?: number }
export interface GoogleApiError { code?: string | number; status?: number; message?: string }
export interface CalendarApi {
 events: {
 list(input: Record<string, unknown>): Promise<{ data: { items?: GoogleEvent[] | null; nextPageToken?: string | null; nextSyncToken?: string | null } }>;
 insert(input: Record<string, unknown>): Promise<{ data: GoogleEvent }>;
 get(input: Record<string, unknown>): Promise<{ data: GoogleEvent }>;
 update(input: Record<string, unknown>): Promise<{ data: GoogleEvent }>;
 delete(input: Record<string, unknown>): Promise<unknown>;
 watch(input: Record<string, unknown>): Promise<{ data: { resourceId?: string | null; expiration?: string | number | null } }>;
 };
 channels: { stop(input: Record<string, unknown>): Promise<unknown> };
}
