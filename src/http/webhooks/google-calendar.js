import {
  getUserIntegration,
  getUserIntegrationByChannelId,
  updateUserIntegrationMetadata,
} from '../../infrastructure/database/integrations.js';
import { reconcileCalendarCompanionReminders } from '../../features/calendar/reconciliation.js';
import { listIncrementalCalendarEvents } from '../../integrations/google/calendar.js';

async function resolveWebhookIntegration({ channelId, channelToken }) {
  let userId = null;

  if (channelToken && channelToken.includes('userId=')) {
    const match = channelToken.match(/userId=([a-zA-Z0-9_-]+)/);
    if (match) userId = match[1];
  }

  let integration = null;
  if (userId) {
    integration = await getUserIntegration(userId, 'google');
  }

  if (!integration) {
    integration = await getUserIntegrationByChannelId(channelId, 'google');
    if (integration) userId = integration.user_id;
  }

  return { userId, integration };
}

async function establishCalendarSyncBaseline(userId) {
  const baseline = await listIncrementalCalendarEvents(userId);
  const nextSyncToken = baseline?.nextSyncToken || null;

  if (nextSyncToken) {
    await updateUserIntegrationMetadata(userId, 'google', {
      calendarSyncToken: nextSyncToken,
      calendarSyncBaselineAt: new Date().toISOString(),
    });
  }

  await reconcileCalendarCompanionReminders({
    userId,
    notifyOnDiscovery: false,
  });

  return nextSyncToken;
}

/**
 * Handle incoming Google Calendar push notification webhooks.
 *
 * Google Calendar pushes empty-body POST requests with headers:
 * - X-Goog-Channel-ID: Unique channel UUID
 * - X-Goog-Resource-State: 'sync' (handshake) | 'exists' (event changed)
 * - X-Goog-Channel-Token: Optional verification token embedded on watch
 *
 * Push notifications only tell us that the calendar changed. We therefore keep
 * a syncToken baseline and only allow proactive "new meeting" notices for event
 * IDs returned by the incremental delta. Full reconciliation still maintains
 * companion reminders and cancellation behavior.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleGoogleCalendarWebhook(req, res) {
  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];
  const channelToken = req.headers['x-goog-channel-token'];

  if (!channelId) {
    return res.status(400).send('Missing X-Goog-Channel-ID header');
  }

  // Acknowledge Google quickly to prevent webhook retry storm.
  res.status(200).send('OK');

  console.log(`[googleCalendarWebhook] Received notification: channel=${channelId} state=${resourceState}`);

  try {
    const { userId, integration } = await resolveWebhookIntegration({ channelId, channelToken });

    if (!userId) {
      console.warn(`[googleCalendarWebhook] No user found for channelId=${channelId}`);
      return;
    }

    // The initial sync handshake establishes a silent baseline. Existing events
    // are backfilled with companion reminders but are never announced as new.
    if (resourceState === 'sync') {
      if (!integration?.metadata?.calendarSyncToken) {
        await establishCalendarSyncBaseline(userId);
      }

      console.log(`[googleCalendarWebhook] Channel sync handshake verified: ${channelId}`);
      return;
    }

    if (resourceState !== 'exists') return;

    const currentSyncToken = integration?.metadata?.calendarSyncToken || null;

    // Fail closed against notification storms. If there is no baseline yet,
    // create it silently and wait for the next real delta before announcing.
    if (!currentSyncToken) {
      await establishCalendarSyncBaseline(userId);
      return;
    }

    const delta = await listIncrementalCalendarEvents(userId, {
      syncToken: currentSyncToken,
    });

    const isFullSyncRecovery = Boolean(delta?.fullSync);

    const changedEvents = (delta?.items || []).filter((event) => (
      event?.id
      && event.status !== 'cancelled'
      && !String(event.id).startsWith('hermes')
    ));

    const changedEventIds = changedEvents.map((event) => event.id);

    const cancelledEventIds = (delta?.items || [])
      .filter((event) => event?.id && event.status === 'cancelled')
      .map((event) => event.id);

    await reconcileCalendarCompanionReminders({
      userId,
      notifyOnDiscovery: !isFullSyncRecovery,
      notifyEventIds: !isFullSyncRecovery ? changedEventIds : [],
      cancelledEventIds: !isFullSyncRecovery ? cancelledEventIds : [],
      extraEvents: !isFullSyncRecovery ? changedEvents : [],
    });

    await updateUserIntegrationMetadata(userId, 'google', {
      calendarSyncToken: delta?.nextSyncToken || currentSyncToken,
      lastWebhookReceivedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[googleCalendarWebhook] Error reconciling calendar for channel ${channelId}:`, err);
  }
}
