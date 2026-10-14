import {
  getAllActiveIntegrations,
  updateUserIntegrationMetadata,
} from '../infrastructure/database/integrations.js';
import {
  listIncrementalCalendarEvents,
  setupGoogleCalendarWatch,
  stopGoogleCalendarWatch,
} from '../integrations/google/calendar.js';
import { reconcileCalendarCompanionReminders } from '../features/calendar/reconciliation.js';

import { createCalendarWatchRenewal } from './calendar-watch-renewal-core.js';

const worker = createCalendarWatchRenewal({ getAllActiveIntegrations: getAllActiveIntegrations as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['getAllActiveIntegrations'], setupGoogleCalendarWatch: setupGoogleCalendarWatch as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['setupGoogleCalendarWatch'], listIncrementalCalendarEvents: listIncrementalCalendarEvents as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['listIncrementalCalendarEvents'], updateUserIntegrationMetadata: updateUserIntegrationMetadata as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['updateUserIntegrationMetadata'], reconcileCalendarCompanionReminders: reconcileCalendarCompanionReminders as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['reconcileCalendarCompanionReminders'], stopGoogleCalendarWatch: stopGoogleCalendarWatch as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['stopGoogleCalendarWatch'], getNow: () => new Date(), getNowMs: () => Date.now(), setInterval: ((...args: Parameters<typeof setInterval>) => setInterval(...args)) as unknown as Parameters<typeof createCalendarWatchRenewal>[0]['setInterval'], logger: console});
export function renewExpiringGoogleCalendarWatches(...args: Parameters<typeof worker.renewExpiringGoogleCalendarWatches>) { return worker.renewExpiringGoogleCalendarWatches(...args); }
export function startCalendarWatchWorker(...args: Parameters<typeof worker.startCalendarWatchWorker>) { return worker.startCalendarWatchWorker(...args); }


