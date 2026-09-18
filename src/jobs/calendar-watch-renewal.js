import { getAllActiveIntegrations } from '../infrastructure/database/integrations.js';
import { setupGoogleCalendarWatch, stopGoogleCalendarWatch } from '../integrations/google/calendar.js';

const RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours

/**
 * Scan all active Google Calendar integrations and ensure each has a valid watch channel.
 * Automatically backfills existing connected users and renews channels expiring within 24h.
 *
 * @param {object} [options]
 * @param {number} [options.thresholdMs=RENEWAL_THRESHOLD_MS]
 * @returns {Promise<{checked: number, established: number, errors: number}>}
 */
export async function renewExpiringGoogleCalendarWatches({
  thresholdMs = RENEWAL_THRESHOLD_MS,
} = {}) {
  const integrations = await getAllActiveIntegrations('google');
  let establishedCount = 0;
  let errorCount = 0;

  console.log(`[calendarWatchRenewal] Checking ${integrations.length} active Google integrations...`);

  for (const integration of integrations) {
    const userId = integration.user_id;
    const metadata = integration.metadata || {};
    const channelId = metadata.channelId;
    const resourceId = metadata.resourceId;
    const expiration = Number(metadata.channelExpiration);

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

  console.log(`[calendarWatchRenewal] Run complete: checked=${integrations.length}, renewed/established=${establishedCount}, errors=${errorCount}`);
  return {
    checked: integrations.length,
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

  // Run initial pass on startup to immediately backfill any existing connected users
  renewExpiringGoogleCalendarWatches().catch(err => {
    console.error('[calendarWatchRenewal] Initial watch pass error:', err);
  });

  setInterval(() => {
    renewExpiringGoogleCalendarWatches().catch(err => {
      console.error('[calendarWatchRenewal] Periodic watch renewal error:', err);
    });
  }, intervalMs);
}
