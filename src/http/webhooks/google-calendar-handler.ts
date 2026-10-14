import { createUserWebhookQueue } from './user-webhook-queue.js';
import type { CalendarWatchPorts, CalendarWatchIntegration, CalendarWatchEvent } from '../../features/calendar/watch-ports.js';
export interface CalendarWebhookRequest { headers: Readonly<Record<string, unknown>> }
export interface CalendarWebhookResponse {
  status(code: number): CalendarWebhookResponse;
  send(body: string): unknown;
}
export interface CalendarWebhookDependencies extends CalendarWatchPorts {
  getUserIntegration(userId: string, provider: 'google'): Promise<CalendarWatchIntegration | null>;
  getUserIntegrationByChannelId(channelId: string, provider: 'google'): Promise<CalendarWatchIntegration | null>;
}

export function createGoogleCalendarWebhook({ getUserIntegration, getUserIntegrationByChannelId, listIncrementalCalendarEvents, updateUserIntegrationMetadata, reconcileCalendarCompanionReminders, stopGoogleCalendarWatch, getNow, logger }: CalendarWebhookDependencies) {
  async function resolveWebhookIntegration({ channelId, channelToken }: { channelId: string; channelToken: string | undefined }) {
    let userId: string | null = null;

    if (channelToken && channelToken.includes('userId=')) {
      const match = channelToken.match(/userId=([a-zA-Z0-9_-]+)/);
      if (match) userId = match[1]!;
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

  async function establishCalendarSyncBaseline(userId: string) {
    const baseline = await listIncrementalCalendarEvents(userId);
    const nextSyncToken = baseline?.nextSyncToken || null;

    if (nextSyncToken) {
      await updateUserIntegrationMetadata(userId, 'google', {
        calendarSyncToken: nextSyncToken,
        calendarSyncBaselineAt: getNow().toISOString(),
      });
    }

    await reconcileCalendarCompanionReminders({
      userId,
      notifyOnDiscovery: false,
    });

    return nextSyncToken;
  }

  const runSerializedForUser = createUserWebhookQueue();

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
  async function handleGoogleCalendarWebhook(req: CalendarWebhookRequest, res: CalendarWebhookResponse) {
    const channelId = req.headers['x-goog-channel-id'] as string | undefined;
    const resourceState = req.headers['x-goog-resource-state'] as string | undefined;
    const channelToken = req.headers['x-goog-channel-token'] as string | undefined;

    if (!channelId) {
      return res.status(400).send('Missing X-Goog-Channel-ID header');
    }

    // Acknowledge Google quickly to prevent webhook retry storm.
    res.status(200).send('OK');

    logger.log(`[googleCalendarWebhook] Received notification: channel=${channelId} state=${resourceState}`);

    try {
      const { userId, integration: initialIntegration } = await resolveWebhookIntegration({ channelId, channelToken });

      if (!userId) {
        logger.warn(`[googleCalendarWebhook] No user found for channelId=${channelId}`);
        return;
      }

      await runSerializedForUser(userId, async () => {
        // Re-read latest user integration metadata under the lock to prevent token race conditions
        const integration = (await getUserIntegration(userId, 'google')) || initialIntegration;

        // Invariant: Enforce single active channel per user.
        // Drop notifications from obsolete/zombie channels and proactively stop them on Google.
        const activeChannelId = integration?.metadata?.channelId;
        if (activeChannelId && activeChannelId !== channelId) {
          logger.warn(`[googleCalendarWebhook] Dropping obsolete watch channel notification for user ${userId}: received=${channelId}, active=${activeChannelId}`);
          const headerResourceId = req.headers['x-goog-resource-id'] as string | undefined;
          if (headerResourceId) {
            stopGoogleCalendarWatch({ userId, channelId, resourceId: headerResourceId }).catch((stopErr) => {
              logger.warn(`[googleCalendarWebhook] Failed to stop obsolete channel ${channelId}:`, (stopErr as Error).message);
            });
          }
          return;
        }

        // The initial sync handshake establishes a silent baseline. Existing events
        // are backfilled with companion reminders but are never announced as new.
        if (resourceState === 'sync') {
          if (!integration?.metadata?.calendarSyncToken) {
            await establishCalendarSyncBaseline(userId);
          }

          logger.log(`[googleCalendarWebhook] Channel sync handshake verified: ${channelId}`);
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

        const changedEventIds = changedEvents.map((event) => event!.id!);

        const cancelledEventIds = (delta?.items || [])
          .filter((event) => event?.id && event.status === 'cancelled')
          .map((event) => event!.id!);

        await reconcileCalendarCompanionReminders({
          userId,
          notifyOnDiscovery: !isFullSyncRecovery,
          notifyEventIds: !isFullSyncRecovery ? changedEventIds : [],
          cancelledEventIds: !isFullSyncRecovery ? cancelledEventIds : [],
          extraEvents: !isFullSyncRecovery ? changedEvents as CalendarWatchEvent[] : [],
        });

        await updateUserIntegrationMetadata(userId, 'google', {
          calendarSyncToken: delta?.nextSyncToken || currentSyncToken,
          lastWebhookReceivedAt: getNow().toISOString(),
        });
      });
    } catch (err) {
      logger.error(`[googleCalendarWebhook] Error reconciling calendar for channel ${channelId}:`, err);
    }
  }
  return { handleGoogleCalendarWebhook };
}
