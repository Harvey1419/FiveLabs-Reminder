import { getUserIntegrationByChannelId, updateUserIntegrationMetadata } from '../../infrastructure/database/integrations.js';
import { reconcileCalendarCompanionReminders } from '../../features/calendar/reconciliation.js';

/**
 * Handle incoming Google Calendar push notification webhooks.
 *
 * Google Calendar pushes empty-body POST requests with headers:
 * - X-Goog-Channel-ID: Unique channel UUID
 * - X-Goog-Resource-State: 'sync' (handshake) | 'exists' (event changed)
 * - X-Goog-Channel-Token: Optional verification token embedded on watch
 * - X-Goog-Resource-ID: Opaque resource ID
 * - X-Goog-Channel-Expiration: Channel expiration string
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleGoogleCalendarWebhook(req, res) {
  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];
  const channelToken = req.headers['x-goog-channel-token'];
  const resourceId = req.headers['x-goog-resource-id'];

  if (!channelId) {
    return res.status(400).send('Missing X-Goog-Channel-ID header');
  }

  // Acknowledge Google quickly to prevent webhook retry storm
  res.status(200).send('OK');

  console.log(`[googleCalendarWebhook] Received notification: channel=${channelId} state=${resourceState}`);

  // 1. Handshake verification ping when channel is created
  if (resourceState === 'sync') {
    console.log(`[googleCalendarWebhook] Channel sync handshake verified: ${channelId}`);
    return;
  }

  // 2. Resource change notification ('exists')
  if (resourceState === 'exists') {
    try {
      let userId = null;

      // Extract userId from token if structured as 'userId=...'
      if (channelToken && channelToken.includes('userId=')) {
        const match = channelToken.match(/userId=([a-zA-Z0-9_-]+)/);
        if (match) {
          userId = match[1];
        }
      }

      // Fallback to database lookup by channelId
      if (!userId) {
        const integration = await getUserIntegrationByChannelId(channelId, 'google');
        if (integration) {
          userId = integration.user_id;
        }
      }

      if (!userId) {
        console.warn(`[googleCalendarWebhook] No user found for channelId=${channelId}`);
        return;
      }

      console.log(`[googleCalendarWebhook] Triggering real-time companion reconciliation for user ${userId}`);

      await reconcileCalendarCompanionReminders({
        userId,
        notifyOnDiscovery: true,
      });

      await Promise.resolve(
        updateUserIntegrationMetadata(userId, 'google', {
          lastWebhookReceivedAt: new Date().toISOString(),
        })
      ).catch(() => {});
    } catch (err) {
      console.error(`[googleCalendarWebhook] Error reconciling calendar for channel ${channelId}:`, err);
    }
  }
}
