import {
  getUserIntegration,
  getUserIntegrationByChannelId,
  updateUserIntegrationMetadata,
} from '../../infrastructure/database/integrations.js';
import { reconcileCalendarCompanionReminders } from '../../features/calendar/reconciliation.js';
import {
  listIncrementalCalendarEvents,
  stopGoogleCalendarWatch,
} from '../../integrations/google/calendar.js';

import { createGoogleCalendarWebhook } from './google-calendar-handler.js';

const handler = createGoogleCalendarWebhook({ getUserIntegration: getUserIntegration as unknown as Parameters<typeof createGoogleCalendarWebhook>[0]['getUserIntegration'], getUserIntegrationByChannelId: getUserIntegrationByChannelId as unknown as Parameters<typeof createGoogleCalendarWebhook>[0]['getUserIntegrationByChannelId'], listIncrementalCalendarEvents: listIncrementalCalendarEvents as unknown as Parameters<typeof createGoogleCalendarWebhook>[0]['listIncrementalCalendarEvents'], updateUserIntegrationMetadata: updateUserIntegrationMetadata as unknown as Parameters<typeof createGoogleCalendarWebhook>[0]['updateUserIntegrationMetadata'], reconcileCalendarCompanionReminders: reconcileCalendarCompanionReminders as unknown as Parameters<typeof createGoogleCalendarWebhook>[0]['reconcileCalendarCompanionReminders'], stopGoogleCalendarWatch: stopGoogleCalendarWatch as unknown as Parameters<typeof createGoogleCalendarWebhook>[0]['stopGoogleCalendarWatch'], getNow: () => new Date(), logger: console});
export function handleGoogleCalendarWebhook(...args: Parameters<typeof handler.handleGoogleCalendarWebhook>) { return handler.handleGoogleCalendarWebhook(...args); }


