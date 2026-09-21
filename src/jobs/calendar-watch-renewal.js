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

const RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours

/**
 * Scan all active Google Calendar integrations and ensure each has:
 * 1. a syncToken baseline for incremental change detection
 * 2. a valid watch channel
 *
 * Existing events are reconciled silently when the baseline is first created,
 * so they keep their companion reminders without generating proactive notices.
 *
 * @param {object} [options]
 * @param {number} [options.thresholdMs=RENEWAL_THRESHOLD_MS]
 * @returns {Promise<{checked: number, baselined: number, established: number, errors: number}>}
 */
export async function renewExpiringGoogleCalendarWatches({
  thresholdMs = RENEWAL_THRESHOLD_MS,
} = {}) {
  const integrations = await getAllActiveIntegrations('google');
  let baselinedCount = 0;
  let establishedCount = 0;
  let errorCount = 0;

  console.log(`[calendarWatchRenewal] Checking ${integrations.length} active Google integrations...`);

  for (const integration of integrations) {
    const userId = integration.user_id;
    const metadata = integration.metadata || {};
    const channelId = metadata.channelId;
    const resourceId = metadata.resourceId;
    const expiration = Number(metadata.channelExpiration);

    if (!metadata.calendarSyncToken) {
      try {
        const baseline = await listIncrementalCalendarEvents(userId);
        const nextSyncToken = baseline?.nextSyncToken || null;

        if (nextSyncToken) {
          await updateUserIntegrationMetadata(userId, 'google', {
            calendarSyncToken: nextSyncToken,
            calendarSyncBaselineAt: new Date().toISOString(),
          });

          await reconcileCalendarCompanionReminders({
            userId,
            notifyOnDiscovery: false,
          });

          baselinedCount += 1;
          console.log(`[calendarWatchRenewal] Sync baseline established for user ${userId}`);
        }
      } catch (err) {
        errorCount += 1;
        console.warn(`[calendarWatchRenewal] Failed to establish sync baseline for user ${userId}:`, err.message);
      }
    }

    const isExpiredOrMissing = !channelId || !expiration || Number.isNaN(expiration);
    const isExpiringSoon = expiration && (expiration - Date.now() <= thresholdMs);

    if (isExpiredOrMissing || isExpiringSoon) {
      try {
        console.log(`[calendarWatchRenewal] Setting up or renewing watch for user ${userId} (channel=${channelId || 'none'}, expiringSoon=${Boolean(isExpiringSoon)})`);

        // Gracefully stop old channel if it existed
        if (channelId && resourceId) {
          await stopGoogleCalendarWatch({ userId, channelId, resourceId }).catch(() => {});
        }

        const watchResult = await setupGoogleCalendarWatch({ userId });
        if (watchResult) {
          establishedCount += 1;
        }
      } catch (err) {
        errorCount += 1;
        console.warn(`[calendarWatchRenewal] Failed to establish watch for user ${userId}:`, err.message);
      }
    }
  }

  console.log(
    `[calendarWatchRenewal] Run complete: checked=${integrations.length}, baselined=${baselinedCount}, renewed/established=${establishedCount}, errors=${errorCount}`,
  );
  return {
    checked: integrations.length,
    baselined: baselinedCount,
    established: establishedCount,
    errors: errorCount,
  };
}

/**
 * Start the background worker that periodically renews expiring Google Calendar watches.
 *
 * @param {number} [intervalMs=CHECK_INTERVAL_MS]
 */
export async function startCalendarWatchWorker(intervalMs = CHECK_INTERVAL_MS) {
  console.log(`[calendarWatchRenewal] Starting periodic renewal worker (interval: ${intervalMs / (60 * 60 * 1000)}h)`);

  // Run initial pass on startup to backfill sync baselines and watch channels.
  renewExpiringGoogleCalendarWatches().catch(err => {
    console.error('[calendarWatchRenewal] Initial watch pass error:', err);
  });

  setInterval(() => {
    renewExpiringGoogleCalendarWatches().catch(err => {
      console.error('[calendarWatchRenewal] Periodic watch renewal error:', err);
    });
  }, intervalMs);
}
