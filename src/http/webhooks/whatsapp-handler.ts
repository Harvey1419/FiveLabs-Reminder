import { createFileTurnInput, createLocationTurnInput } from '../../shared/turn-media-input.js';
import type { TurnMediaInput } from '@templelabs/contracts';
import { v2DeliveryReceipt } from '../../adapters/agent-core/canary-delivery-receipt.js';
import type { WhatsAppPayload, WhatsAppRequest, WhatsAppResponse, WhatsAppDomainRow, WhatsAppStatus, WhatsAppWebhookDependencies, WhatsAppDelivery } from './whatsapp-ports.js';

/** Legacy webhook behavior with typed, lazily bound host ports. */
export function createWhatsAppWebhook({ enqueueInboundTurn, assertTurnLease, checkpointTurnResponse, withoutTurnLease, clearWorkingMemory, routeMessage, sendWhatsAppText, sendWhatsAppCtaUrl, sendWhatsAppFlow, sendWhatsAppQuickReplyButtons, sendWhatsAppListMessage, sendTypingIndicator, downloadMedia, normalizePhoneNumber, saveMessage, getRecentMessages, isMessageAlreadyProcessed, getAssistantMessageById, getOrCreateUserByPhone, touchUserLastActive, updateReminderDeliveryStatus, acknowledgeReminder, acknowledgeRemindersByTaskId, updateReminder, updateTask, extractMemoryInBackground, withQueryEmbeddingScope, transcribeAudio, processDocumentOrImage, getNearestCityFromCoordinates, extractCurrentUserText, isIntradayRecurrence, getEnv, getNow, getNowMs, randomUUID, setTimeout, logger }: WhatsAppWebhookDependencies) {
  // In-memory dedup set for message IDs as fast-path optimization (DB is true source of truth).
  const recentlyProcessed = new Set<string>();
  const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

  function markAsProcessed(messageId: string | null | undefined) {
    if (!messageId) return;
    recentlyProcessed.add(messageId);
    setTimeout(() => recentlyProcessed.delete(messageId), DEDUP_TTL_MS).unref?.();
  }

  function isDuplicate(messageId: string | null | undefined) {
    if (!messageId) return false;
    if (recentlyProcessed.has(messageId)) return true;
    markAsProcessed(messageId);
    return false;
  }

  // Per-user in-flight promise queue to guarantee FIFO order across concurrent messages from the same user
  const userQueueMap = new Map<string, Promise<unknown>>();

  /**
   * Execute task in sequential order per user.
   */
  async function enqueueForUser<T>(userIdOrPhone: unknown, taskFn: () => T | Promise<T>): Promise<T> {
    const key = String(userIdOrPhone || 'global_queue');
    const prevPromise = userQueueMap.get(key) || Promise.resolve();

    const currentPromise = (async () => {
      try {
        await prevPromise;
      } catch {
        // Ignore previous task failure and continue
      }
      return taskFn();
    })();

    userQueueMap.set(key, currentPromise);
    currentPromise.then(() => {
      if (userQueueMap.get(key) === currentPromise) {
        userQueueMap.delete(key);
      }
    }, () => {
      if (userQueueMap.get(key) === currentPromise) userQueueMap.delete(key);
    });

    return currentPromise;
  }

  /**
   * Dynamically extract originating phoneNumberId (Sandbox vs Production) from Meta/Kapso payload.
   */
  function extractPhoneNumberId(payload: WhatsAppPayload | null | undefined) {
    if (!payload || typeof payload !== 'object') {
      return getEnv().KAPSO_PHONE_NUMBER_ID || getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID || '1248246475047194';
    }

    const changeValue = payload.entry?.[0]?.changes?.[0]?.value || {};
    const metadata = changeValue.metadata || {};

    const id = payload.phone_number_id
      || metadata.phone_number_id
      || changeValue.phone_number_id
      || payload.conversation?.phone_number_id
      || payload.data?.phone_number_id
      || payload.message?.phone_number_id
      || getEnv().KAPSO_PHONE_NUMBER_ID
      || getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID
      || '1248246475047194';

    return String(id).trim();
  }

  /**
   * Clean contact information separating E.164 phone numbers and BSUIDs.
   */
  function extractContactInfo(payload: WhatsAppPayload) {
    const message = payload.message
      || payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      || payload.data?.message
      || (payload.text ? payload : null);

    const conversation = payload.conversation || payload.data?.conversation || {};
    const changeValue = payload.entry?.[0]?.changes?.[0]?.value || {};

    // 1. Phone number (E.164 without +)
    const rawPhone = message?.from
      || conversation?.phone_number
      || changeValue.contacts?.[0]?.wa_id
      || changeValue.messages?.[0]?.from
      || payload.phone_number
      || payload.from
      || null;

    const phoneNumber = normalizePhoneNumber(rawPhone);

    // 2. BSUID (Business-Scoped User ID, e.g. CO.1552339023039755)
    let bsuid = message?.from_user_id
      || conversation?.business_scoped_user_id
      || changeValue.contacts?.[0]?.user_id
      || (rawPhone && rawPhone.includes('.') ? rawPhone : null)
      || null;

    if (bsuid && typeof bsuid === 'string') {
      bsuid = bsuid.trim();
    }

    // 3. Display Name
    const displayName = conversation?.contact_name
      || changeValue.contacts?.[0]?.profile?.name
      || (message?.username ? `@${message.username}` : null)
      || null;

    return { phoneNumber, bsuid, displayName, message };
  }

  /**
   * Check if the webhook payload represents an outbound/bot message to avoid feedback loops.
   */
  function isOutboundMessage(payload: WhatsAppPayload) {
    if (payload.message?.kapso?.direction === 'outbound') return true;
    if (payload.message?.direction === 'outbound') return true;
    if (payload.direction === 'outbound') return true;
    if (payload.message?.from_me === true || payload.from_me === true) return true;
    if (payload.message?.kapso?.origin === 'agent' || payload.message?.kapso?.origin === 'api') return true;
    if (payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from_me === true) return true;
    return false;
  }

  function extractDeliveryStatuses(payload: WhatsAppPayload = {}) {
    const metaStatuses = (payload.entry || [])
      .flatMap((entry) => entry?.changes || [])
      .flatMap((change) => change?.value?.statuses || []);
    const directStatuses = Array.isArray(payload.statuses) ? payload.statuses : [];
    const message = payload.message || payload.data?.message || null;
    const kapsoStatus: WhatsAppStatus[] = message?.id && message?.kapso?.direction === 'outbound' && message?.kapso?.status
      ? [{ id: message.id, status: message.kapso.status, errors: message.errors || null }]
      : [];

    return [...metaStatuses, ...directStatuses, ...kapsoStatus]
      .filter((status) => status?.id && status?.status)
      .map((status) => ({
        deliveryId: status.id!,
        deliveryStatus: String(status.status).toLowerCase(),
        errorDetails: status.errors || status.error || null,
      }));
  }

  /** Persist all inbound messages before acknowledging them to the provider. */
  async function handleWebhook(req: WhatsAppRequest, res: WhatsAppResponse) {
    const body = req.body || {};
    const correlationId = req.headers?.['x-correlation-id'] || req.headers?.['x-request-id'] || randomUUID();
    const requests: WhatsAppPayload[] = [];
    const changes = (body.entry || []).flatMap(entry => (entry.changes || []).map(change => ({ entry, change })));
    for (const { entry, change } of changes) {
      for (const message of change.value?.messages || []) {
        requests.push({ ...body, entry: [{ ...entry, changes: [{ ...change, value: { ...change.value, messages: [message] } }] }] });
      }
    }
    if (!requests.length) requests.push(body);
    try {
      for (const payload of requests) {
        const { phoneNumber, bsuid, message } = extractContactInfo(payload);
        if (!message || isOutboundMessage(payload)) {
          await processWebhookMessage({ body: payload, headers: { 'x-correlation-id': correlationId } });
          continue;
        }
        const messageId = message.id || payload.id || payload.data?.id;
        if (!messageId || (!phoneNumber && !bsuid)) return res.status(400).send('Missing message identity');
        await enqueueInboundTurn({ messageId, threadId: (phoneNumber || bsuid)!,
          request: { body: payload, headers: { 'x-correlation-id': correlationId }, receivedAt: getNowMs() } });
      }
      return res.status(200).send('OK');
    } catch (error) {
      logger.error(`[webhook req=${correlationId}] ingress not persisted code=${(error as { message?: string; code?: string }).code || 'STORAGE_ERROR'}`);
      // The provider may retry; uniqueness prevents re-enqueuing already accepted messages.
      return res.status(503).send('Temporarily unavailable');
    }
  }

  /** Worker-only processing; the durable inbox owns delivery deduplication and order. */
  async function processWebhookMessage(req: WhatsAppRequest) {
    const correlationId = req.headers?.['x-correlation-id'] || req.headers?.['x-request-id'] || randomUUID();
    const startTime = req.receivedAt || getNowMs();

    try {
      const body = req.body || {};

      // Reconcile provider delivery truth before ignoring status-only events.
      const deliveryStatuses = extractDeliveryStatuses(body);
      if (deliveryStatuses.length > 0) {
        const outcomes = await Promise.all(deliveryStatuses.map(async (status) => {
          if (status.deliveryStatus === 'failed') {
            logger.warn(`[webhook req=${correlationId}] provider reported failed message delivery`);
          }
          try {
            if (await updateReminderDeliveryStatus(status)) return 'reminder';
            if (await getAssistantMessageById(status.deliveryId)) return 'conversation';
            // A callback can arrive before persistence or refer to another sender.
            // Unmatched is not proof of a failed reminder update or successful delivery.
            return 'unmatched';
          } catch (error) {
            logger.warn(`[webhook req=${correlationId}] delivery status persistence failed:`, String((error as { message?: string } | null | undefined)?.message || error).slice(0, 180));
            return 'failed';
          }
        }));
        const count = (kind: string) => outcomes.filter((outcome) => outcome === kind).length;
        logger.log(`[webhook req=${correlationId}] delivery status outcomes reminder=${count('reminder')} conversation=${count('conversation')} unmatched=${count('unmatched')} failed=${count('failed')}`);
      }
      const isStatusUpdate = deliveryStatuses.length > 0 || Boolean(body.status);
      if (isStatusUpdate && !body.message && !body.entry?.[0]?.changes?.[0]?.value?.messages) {
        return;
      }

      // 4. Strict loop guard: Ignore outbound/agent messages
      if (isOutboundMessage(body)) {
        return;
      }

      // 5. Extract contact info & message
      const { phoneNumber, bsuid, displayName, message } = extractContactInfo(body);

      if (!message) {
        return;
      }

      const messageId = message.id || body.id || body.data?.id;

      // Log ingress arrival vs original message creation timestamp
      const rawMsgTs = message.timestamp || body.message?.timestamp || body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.timestamp || null;
      let msgIso = 'N/A';
      let transitLagMs = null;
      let requestTimeMs = startTime;
      if (rawMsgTs) {
        const msgEpochMs = String(rawMsgTs).length <= 10 ? Number(rawMsgTs) * 1000 : Number(rawMsgTs);
        if (!isNaN(msgEpochMs)) {
          requestTimeMs = msgEpochMs;
          msgIso = new Date(msgEpochMs).toISOString();
          transitLagMs = getNowMs() - msgEpochMs;
        }
      }
      logger.log(`[webhook-ingress req=${correlationId}] Webhook recibido: ${getNow().toISOString()} | Message timestamp: ${rawMsgTs} (${msgIso}) | Transit lag: ${transitLagMs !== null ? `${transitLagMs}ms` : 'unknown'}`);

      // Idempotency: Ignore duplicate message IDs (Fast-path RAM check + Persistent DB check)
      if (isDuplicate(messageId) || (messageId && await isMessageAlreadyProcessed(messageId))) {
        logger.log(`[webhook req=${correlationId}] Duplicate inbound messageId=${messageId} ignored.`);
        return;
      }

      // Must have at least one recipient identifier (phone or bsuid)
      if (!phoneNumber && !bsuid) {
        logger.warn(`[webhook req=${correlationId}] Inbound message dropped: missing both phoneNumber and bsuid.`);
        return;
      }

      const recipientIdentifier = (phoneNumber || bsuid)!;
      const phoneNumberId = extractPhoneNumberId(body);

      const queueEnqueueTime = getNowMs();
      // Enqueue processing sequentially for this recipient to prevent context race conditions
      await enqueueForUser(recipientIdentifier, async () => {
        const queueWaitMs = getNowMs() - queueEnqueueTime;

        // 1. Resolve User Record
        const tUser0 = getNowMs();
        const user = await getOrCreateUserByPhone(recipientIdentifier, null, 'es-CO', displayName, { fresh: true });
        const userResolveMs = getNowMs() - tUser0;
        if (!user?.id) throw Object.assign(new Error('User persistence unavailable'), { code: 'USER_STORAGE_UNAVAILABLE' });
        await assertTurnLease();

        return withQueryEmbeddingScope(user.id, async () => {
        let messageText = ((message.text as { body?: string } | undefined)?.body || message.text || body.text || body.data?.text || '') as string;
        const caption = message.caption || message.image?.caption || message.document?.caption || '';

        // Fast-path: WhatsApp Interactive Button Replies & Flow Submissions (Zero LLM Turn, Instant Execution)
        const interactiveObj = message.interactive || body.message?.interactive || body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive;
        const interactiveHistory = interactiveObj ? await getRecentMessages(recipientIdentifier, 10) : [];
        const priorLanguage = [...(interactiveHistory || [])].reverse().find(turn => turn.role === 'assistant' && ['en', 'es'].includes(turn.entities?._responseLanguage as string))?.entities?._responseLanguage;
        const interactiveLanguage = priorLanguage || (user?.locale?.startsWith('en') ? 'en' : 'es');
        const reportUnconfirmedAction = async () => {
          const text = interactiveLanguage === 'en'
            ? 'I could not confirm this action. Please check its current status before trying again.'
            : 'No pude confirmar esta acción. Revisa su estado actual antes de intentarlo de nuevo.';
          await checkpointTurnResponse({ confirmation: text, intent: 'action_unconfirmed' });
          await sendWhatsAppText({ phoneNumberId, phoneNumber, bsuid, text });
          await saveMessage({ userId: user.id, phoneNumber: recipientIdentifier, role: 'assistant', content: text, intent: 'action_unconfirmed', entities: { _responseLanguage: interactiveLanguage } });
        };


        const partialWarning = interactiveLanguage === 'en'
          ? '\n\n⚠️ I could not confirm all related changes. Please check their current status before retrying.'
          : '\n\n⚠️ No pude confirmar todos los cambios relacionados. Revisa su estado actual antes de reintentarlos.';
        const completeReminderDependencies = async (reminder: WhatsAppDomainRow) => {
          let incomplete = false;
          if (reminder.task_id) {
            const result = await updateTask(reminder.task_id, { status: 'completed' }, user.id);
            const task = result?.data || result;
            incomplete = !task?.id || task.status !== 'completed';
          }
          if (isIntradayRecurrence(reminder.recurrence_rule)) {
            const cancelled = await updateReminder(reminder.id!, { status: 'cancelled' }, user.id, user.phone_number);
            incomplete ||= !cancelled?.id || cancelled.status !== 'cancelled';
          }
          return incomplete;
        };


        // Handle WhatsApp Flow Completion (nfm_reply)
        if (interactiveObj?.type === 'nfm_reply' || interactiveObj?.nfm_reply) {
          const nfmReply = interactiveObj.nfm_reply || interactiveObj;
          const rawResponse = nfmReply.response_json || nfmReply.responseJson || '{}';
          let parsedData: { selected_ids?: unknown; selected_tasks?: unknown } = {};
          try {
            parsedData = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : (rawResponse || {});
          } catch (e) {
            logger.warn(`[webhook fast-path req=${correlationId}] Failed to parse Flow response_json:`, (e as { message?: string; code?: string }).message);
          }

          const rawSelected = parsedData.selected_ids || parsedData.selected_tasks || [];
          const selectedIds = [...new Set(Array.isArray(rawSelected) ? rawSelected : (rawSelected ? [rawSelected] : []))].slice(0, 10);

          if (selectedIds.length > 0) {
            const completedTasks: WhatsAppDomainRow[] = [];
            let incomplete = false;
            for (const taskId of selectedIds) {
              try {
                const res = await updateTask(taskId, { status: 'completed' }, user.id);
                const taskRecord = res?.data || res;
                if (!taskRecord?.id || taskRecord.status !== 'completed') { incomplete = true; break; }
                completedTasks.push(taskRecord);
                const companions = await acknowledgeRemindersByTaskId(taskRecord.id, user.id);
                if (companions?.error) { incomplete = true; break; }
              } catch (err) {
                logger.warn(`[webhook fast-path req=${correlationId}] Error completing task ${taskId} from flow:`, (err as { message?: string; code?: string }).message);
                incomplete = true;
                break;
              }
            }

            const isEnglishUser = interactiveLanguage === 'en';
            let confirmText;
            if (completedTasks.length === 0) {
              confirmText = isEnglishUser
                ? '⚠️ The selected tasks could not be updated or were already completed.'
                : '⚠️ Las tareas seleccionadas no pudieron actualizarse o ya estaban completadas.';
            } else if (completedTasks.length === 1) {
              const t = completedTasks[0]!;
              confirmText = isEnglishUser
                ? `✅ *Task completed*\n\n• ${t.title || t.content || 'Task'}`
                : `✅ *Tarea completada*\n\n• ${t.title || t.content || 'Tarea'}`;
            } else {
              const taskLines = completedTasks.map((t) => `• ${t.title || t.content || 'Tarea'}`).join('\n');
              confirmText = isEnglishUser
                ? `✅ *${completedTasks.length} tasks completed*\n\n${taskLines}`
                : `✅ *${completedTasks.length} tareas completadas*\n\n${taskLines}`;
            }

            if (incomplete || completedTasks.length < selectedIds.length) confirmText += partialWarning;

            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'user',
              content: '[Flujo completado: tareas]',
              messageId: messageId || null,
              intent: 'task_complete_flow_submit',
              entities: { completedTaskIds: completedTasks.map(task => task.id), _responseLanguage: interactiveLanguage },
            });
            touchUserLastActive(user.id, recipientIdentifier);

            await sendWhatsAppText({
              phoneNumberId,
              phoneNumber,
              bsuid,
              text: confirmText,
            });

            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'assistant',
              content: confirmText,
              intent: 'task_complete_flow',
              entities: { completedTaskIds: completedTasks.map(task => task.id), _responseLanguage: interactiveLanguage },
            });

            logger.log(`[webhook fast-path req=${correlationId}] Flow completed ${completedTasks.length}/${selectedIds.length} tasks in ${getNowMs() - queueEnqueueTime}ms`);
            return;
          }
        }

        const buttonReply = interactiveObj?.button_reply || message.button_reply;
        if (buttonReply?.id) {
          const buttonId = String(buttonReply.id || '').trim();
          if (buttonId.startsWith('rem:ack:')) {
            const reminderId = buttonId.replace('rem:ack:', '').trim();
            const ackResult = await acknowledgeReminder(reminderId, user.id);
            if (!ackResult?.id) { await reportUnconfirmedAction(); return; }
            let incomplete = false;
            try { incomplete = await completeReminderDependencies(ackResult); }
            catch { incomplete = true; }
            try {
              clearWorkingMemory(user);
              if (phoneNumber) clearWorkingMemory(phoneNumber);
            } catch (memErr) {
              logger.warn(`[webhook fast-path req=${correlationId}] clearWorkingMemory warning:`, (memErr as { message?: string; code?: string }).message);
            }
            const isEnglishUser = interactiveLanguage === 'en';
            const confirmText = (isEnglishUser
              ? '✅ Great! I’ve marked this reminder as completed.'
              : '✅ ¡Excelente! He marcado este recordatorio como completado.') + (incomplete ? partialWarning : '');

            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'user',
              content: buttonReply.title || (isEnglishUser ? 'Done' : 'Listo'),
              messageId: messageId || null,
              intent: 'reminder_ack_click',
              entities: { reminderId, _responseLanguage: interactiveLanguage },
            });
            touchUserLastActive(user.id, recipientIdentifier);

            await sendWhatsAppText({
              phoneNumberId,
              phoneNumber,
              bsuid,
              text: confirmText,
            });
            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'assistant',
              content: confirmText,
              intent: 'reminder_ack',
              entities: { reminderId, _responseLanguage: interactiveLanguage },
            });
            logger.log(`[webhook fast-path req=${correlationId}] reminder ${reminderId} acknowledged via button reply in ${getNowMs() - queueEnqueueTime}ms`);
            return;
          }

          if (buttonId.startsWith('rem:snooze:')) {
            const parts = buttonId.split(':');
            const minutes = Number(parts[2]);
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { await reportUnconfirmedAction(); return; }
            const reminderId = parts[3] ? parts.slice(3).join(':').trim() : '';
            const newSendAt = new Date(getNowMs() + minutes * 60 * 1000).toISOString();
            const snoozed = await updateReminder(
              reminderId,
              {
                send_at: newSendAt,
                status: 'pending',
                acknowledged_at: null,
                last_nudged_at: null,
                nudge_count: 0,
              },
              user.id,
              user.phone_number
            );
            if (!snoozed?.id || new Date(snoozed.send_at as string | number | Date).getTime() !== new Date(newSendAt).getTime() || snoozed.status !== 'pending') { await reportUnconfirmedAction(); return; }
            const isEnglishUser = interactiveLanguage === 'en';
            const confirmText = isEnglishUser
              ? `⏰ Got it, I’ll remind you again in ${minutes} minutes.`
              : `⏰ Listo, te lo recordaré nuevamente en ${minutes} minutos.`;

            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'user',
              content: buttonReply.title || `+${minutes} min`,
              messageId: messageId || null,
              intent: 'reminder_snooze_click',
              entities: { reminderId, minutes, newSendAt, _responseLanguage: interactiveLanguage },
            });
            touchUserLastActive(user.id, recipientIdentifier);

            await sendWhatsAppText({
              phoneNumberId,
              phoneNumber,
              bsuid,
              text: confirmText,
            });
            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'assistant',
              content: confirmText,
              intent: 'reminder_snooze',
              entities: { reminderId, minutes, newSendAt, _responseLanguage: interactiveLanguage },
            });
            logger.log(`[webhook fast-path req=${correlationId}] reminder ${reminderId} snoozed by ${minutes}m via button reply in ${getNowMs() - queueEnqueueTime}ms`);
            return;
          }

          if (buttonReply.title && !messageText) {
            messageText = buttonReply.title;
          }
        }

        const listReply = interactiveObj?.list_reply || message.list_reply;
        if (listReply?.id) {
          const listId = String(listReply.id || '').trim();

          if (listId.startsWith('task:done:')) {
            const taskId = listId.replace('task:done:', '').trim();
            try {
              const res = await updateTask(taskId, { status: 'completed' }, user.id);
              const taskRecord = res?.data || res;
              if (!taskRecord?.id || taskRecord.status !== 'completed') { await reportUnconfirmedAction(); return; }
              let companions;
              try { companions = await acknowledgeRemindersByTaskId(taskRecord.id, user.id); }
              catch { companions = { error: true }; }
              const isEnglishUser = interactiveLanguage === 'en';
              const taskTitle = taskRecord?.title || taskRecord?.content || (isEnglishUser ? 'Task' : 'Tarea');
              let confirmText = isEnglishUser
                ? `✅ *Task completed*\n\nAwesome! 🎯 You crossed off *${taskTitle}*. One less thing on your plate.`
                : `✅ *Tarea completada*\n\n¡Excelente! 🎯 Tachaste *${taskTitle}*. Un pendiente menos en tu agenda.`;
              if (companions?.error) confirmText += partialWarning;

              await saveMessage({
                userId: user.id,
                phoneNumber: recipientIdentifier,
                role: 'user',
                content: listReply.title || taskTitle,
                messageId: messageId || null,
                intent: 'task_complete_list_click',
                entities: { taskId, _responseLanguage: interactiveLanguage },
              });
              touchUserLastActive(user.id, recipientIdentifier);

              await sendWhatsAppText({
                phoneNumberId,
                phoneNumber,
                bsuid,
                text: confirmText,
              });

              await saveMessage({
                userId: user.id,
                phoneNumber: recipientIdentifier,
                role: 'assistant',
                content: confirmText,
                intent: 'task_complete_list',
                entities: { taskId, _responseLanguage: interactiveLanguage },
              });

              logger.log(`[webhook fast-path req=${correlationId}] task ${taskId} completed via list reply in ${getNowMs() - queueEnqueueTime}ms`);
              return;
            } catch (taskErr) {
              logger.warn(`[webhook fast-path req=${correlationId}] task list click error:`, (taskErr as { message?: string; code?: string }).message);
              throw taskErr;
            }
          }

          if (listId.startsWith('rem:ack:')) {
            const reminderId = listId.replace('rem:ack:', '').trim();
            const ackResult = await acknowledgeReminder(reminderId, user.id);
            if (!ackResult?.id) { await reportUnconfirmedAction(); return; }
            let incomplete = false;
            try { incomplete = await completeReminderDependencies(ackResult); }
            catch { incomplete = true; }
            try {
              clearWorkingMemory(user);
              if (phoneNumber) clearWorkingMemory(phoneNumber);
            } catch (memErr) {
              logger.warn(`[webhook fast-path req=${correlationId}] clearWorkingMemory warning:`, (memErr as { message?: string; code?: string }).message);
            }
            const isEnglishUser = interactiveLanguage === 'en';
            const confirmText = (isEnglishUser
              ? '✅ Great! I’ve marked this reminder as completed.'
              : '✅ ¡Excelente! He marcado este recordatorio como completado.') + (incomplete ? partialWarning : '');

            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'user',
              content: listReply.title || (isEnglishUser ? 'Done' : 'Listo'),
              messageId: messageId || null,
              intent: 'reminder_ack_click',
              entities: { reminderId, _responseLanguage: interactiveLanguage },
            });
            touchUserLastActive(user.id, recipientIdentifier);

            await sendWhatsAppText({
              phoneNumberId,
              phoneNumber,
              bsuid,
              text: confirmText,
            });
            await saveMessage({
              userId: user.id,
              phoneNumber: recipientIdentifier,
              role: 'assistant',
              content: confirmText,
              intent: 'reminder_ack',
              entities: { reminderId, _responseLanguage: interactiveLanguage },
            });
            logger.log(`[webhook fast-path req=${correlationId}] reminder ${reminderId} acknowledged via list reply in ${getNowMs() - queueEnqueueTime}ms`);
            return;
          }

          if (listReply.title && !messageText) {
            messageText = listReply.title;
          }
        }

        // Show typing indicator immediately
        if (messageId) {
          sendTypingIndicator(messageId, phoneNumberId).catch((err) => {
            logger.warn(`[webhook req=${correlationId}] sendTypingIndicator background error:`, (err as { message?: string } | null | undefined)?.message || err);
          });
        }

        // 2. Handle Multimodal Media (Audio, Images, PDFs, Documents, Location)
        const audioObj = message.audio || body.message?.audio;
        const isAudio = message.type === 'audio' || Boolean(audioObj);
        const isImage = message.type === 'image' || Boolean(message.image);
        const isDocument = message.type === 'document' || Boolean(message.document);
        const isLocation = message.type === 'location' || Boolean(message.location);

        let mediaElapsedMs = 0;
        let attachmentOnly = false;
        let agentCoreMedia: TurnMediaInput | undefined;
        if (isLocation) {
          const loc = message.location || {};
          const lat = loc.latitude;
          const lon = loc.longitude;
          const locName = loc.name || loc.address || '';
          const nearest = getNearestCityFromCoordinates(lat, lon);
          const placeText = locName || (nearest ? `${nearest.city}, ${nearest.region || nearest.country}` : '');
          if (messageId) agentCoreMedia = createLocationTurnInput(user.id, messageId, lat, lon, placeText) ?? undefined;
          attachmentOnly = true;
          messageText = `[Ubicación compartida: ${placeText ? `${placeText} ` : ''}(lat ${lat}, lon ${lon})]`;
        } else if (isAudio && (audioObj?.id || message.id || audioObj?.media_url || audioObj?.url || audioObj?.download_url)) {
          const mediaStart = getNowMs();
          const mediaId = audioObj?.id || message.id;
          const directMediaUrl = audioObj?.media_url || audioObj?.url || audioObj?.download_url || audioObj?.link || message?.media_url || body?.media_url || null;
          logger.log(`[webhook req=${correlationId}] Downloading voice note mediaId=${mediaId}...`);
          const audioBlob = await downloadMedia(mediaId, phoneNumberId, directMediaUrl);
          if (audioBlob) {
            const mimeType = audioObj?.mime_type || 'audio/ogg';
            const audioLang = user?.locale?.startsWith('en') ? 'en' : 'es';
            const transcribed = await transcribeAudio(audioBlob, mimeType, { language: audioLang });
            if (transcribed) {
              messageText = transcribed;
              logger.log(`[webhook req=${correlationId}] Audio transcribed via Whisper: "${messageText}"`);
            }
          }
          mediaElapsedMs = getNowMs() - mediaStart;
        } else if (isImage && (message.image?.id || message.id)) {
          const mediaStart = getNowMs();
          const mediaId = message.image?.id || message.id;
          logger.log(`[webhook req=${correlationId}] Downloading image mediaId=${mediaId}...`);
          const imageBuffer = await downloadMedia(mediaId, phoneNumberId);
          if (imageBuffer) {
            const mimeType = message.image?.mime_type || 'image/jpeg';
            const extracted = await processDocumentOrImage(imageBuffer, mimeType, caption);
            if (extracted?.trim()) {
              attachmentOnly = !caption.trim();
              if (messageId) agentCoreMedia = createFileTurnInput(user.id, messageId, 'image', caption, extracted);
              messageText = caption
                ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
                : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
              logger.log(`[webhook req=${correlationId}] Image analyzed: "${messageText.slice(0, 90)}..."`);
            }
          }
          mediaElapsedMs = getNowMs() - mediaStart;
        } else if (isDocument && (message.document?.id || message.id)) {
          const mediaStart = getNowMs();
          const mediaId = message.document?.id || message.id;
          logger.log(`[webhook req=${correlationId}] Downloading document mediaId=${mediaId}...`);
          const docBuffer = await downloadMedia(mediaId, phoneNumberId);
          if (docBuffer) {
            const mimeType = message.document?.mime_type || 'application/pdf';
            const extracted = await processDocumentOrImage(docBuffer, mimeType, caption);
            if (extracted?.trim()) {
              attachmentOnly = !caption.trim();
              if (messageId) agentCoreMedia = createFileTurnInput(user.id, messageId, 'document', caption, extracted);
              messageText = caption
                ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
                : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
              logger.log(`[webhook req=${correlationId}] Document analyzed: "${messageText.slice(0, 90)}..."`);
            }
          }
          mediaElapsedMs = getNowMs() - mediaStart;
        }

        if (!messageText && (isImage || isDocument) && caption.trim()) {
          messageText = caption.trim();
        }
        if (!messageText && (isAudio || isImage || isDocument)) {
          const mediaLabel = isAudio ? 'audio' : (isImage ? 'imagen' : 'documento');
          const failureText = user?.locale?.startsWith('en')
            ? 'I could not process that attachment. I took no action based on its content; you can resend it or type your request.'
            : `No pude procesar ese ${mediaLabel} en este momento. No ejecuté ninguna acción basada en su contenido; puedes reenviarlo o escribir la instrucción en texto.`;
          await sendWhatsAppText({
            phoneNumberId,
            phoneNumber,
            bsuid,
            text: failureText,
          });
          await saveMessage({
            userId: user.id,
            phoneNumber: recipientIdentifier,
            role: 'assistant',
            content: failureText,
            intent: 'media_error',
            entities: {},
          });
          return;
        }

        if (!messageText) {
          return;
        }

        // Keep the current user-authored words separate from model-only quoted/OCR context.
        // Transcripts count as current input; image/document extraction never does.
        const currentUserText = isLocation
          ? ''
          : extractCurrentUserText(messageText, (isImage || isDocument) ? caption : undefined);

        // Extract WhatsApp quoted/replied message context (Swipe to Reply)
        const contextObj = message.context || body.message?.context || body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.context;
        const quotedText = contextObj?.quoted_content || contextObj?.body || contextObj?.text || (contextObj?.message?.text as { body?: string } | undefined)?.body || contextObj?.message?.text || null;
        if (quotedText && typeof quotedText === 'string' && quotedText.trim().length > 0) {
          logger.log(`[webhook req=${correlationId}] Quoted message detected: "${quotedText.slice(0, 60)}..."`);
          messageText = `<untrusted_quoted_message>${quotedText.trim()}</untrusted_quoted_message>\n${messageText}`;
        }

        const logContact = displayName ? `"${displayName}" (${recipientIdentifier})` : recipientIdentifier;
        logger.log(`[webhook req=${correlationId}] Inbound from ${logContact}: "${messageText.slice(0, 90)}..."`);

        // 3. PERSIST USER MESSAGE FIRST AND AWAIT (Guarantees chronological order and DB-level deduplication)
        const tSave0 = getNowMs();
        const savedUserMsg = await saveMessage({
          userId: user.id,
          phoneNumber: recipientIdentifier,
          role: 'user',
          content: messageText,
          messageId: messageId || null,
          entities: {
            _transport: {
              provider: 'whatsapp',
              phoneNumberId,
            },
          },
        });
        const dbSaveUserMs = getNowMs() - tSave0;

        // A storage error must not be mislabeled as deduplication or allow tools without history.
        if (!savedUserMsg) {
          if (messageId && await isMessageAlreadyProcessed(messageId)) return;
          throw Object.assign(new Error('Inbound conversation persistence failed'), { code: 'MESSAGE_STORAGE_UNAVAILABLE' });
        }
        touchUserLastActive(user.id, recipientIdentifier);

        // 4. Fetch updated conversation history including this message. Typed
        // Working Memory is persisted in assistant entities, so a larger window
        // also survives process restarts without reconstructing identity from prose.
        const tHist0 = getNowMs();
        const history = await getRecentMessages(recipientIdentifier, 40);
        const dbHistoryMs = getNowMs() - tHist0;

        // 5. Route every turn through the canonical Hermes pipeline. A no-caption
        // attachment is explicitly marked so router-core can expose conversation.reply
        // only while keeping the extracted file content untrusted.
        const routeStart = getNowMs();
        const inputModality = isImage ? 'image' : isDocument ? 'document' : isAudio ? 'audio' : isLocation ? 'location' : 'text';
        const routedUserId = user.id;
        const result = await routeMessage(messageText, user, history, {
          correlationId,
          requestTimeMs,
          inputModality,
          attachmentOnly,
          currentUserText,
          ...(agentCoreMedia ? { agentCoreMedia } : {}),
          agentCoreAuthorizeWrite: async (_call, context) => {
            context.signal.throwIfAborted();
            await assertTurnLease();
            context.signal.throwIfAborted();
            return context.userId === routedUserId;
          },
          agentCoreDelivery: { send: async message => {
            await assertTurnLease();
            let receipt;
            if (message.kind === 'text') receipt = await sendWhatsAppText({ phoneNumberId, phoneNumber, bsuid, text: message.text });
            else if (message.kind === 'cta') receipt = await sendWhatsAppCtaUrl({ phoneNumberId, phoneNumber, bsuid,
              headerText: message.cta.header, bodyText: message.text, buttonText: message.cta.buttonText, url: message.cta.url });
            else receipt = await sendWhatsAppFlow({ phoneNumberId, phoneNumber, bsuid, bodyText: message.text,
              buttonText: message.flow.buttonText, flowId: message.flow.flowId, flowToken: message.flow.flowToken,
              flowAction: message.flow.flowAction, screen: message.flow.screen, flowData: message.flow.data, mode: message.flow.mode });
            if (!receipt.success || !receipt.messageId) throw new Error('DELIVERY_OUTCOME_UNKNOWN');
            return { messageId: receipt.messageId };
          } },
        });
        const routeElapsedMs = getNowMs() - routeStart;
        // Preserve the observed answer before transport; recovery never reexecutes its tools.
        await checkpointTurnResponse({ confirmation: result.confirmation, intent: result.intent,
          entities: result.entities, executionFacts: result.executionFacts });
        await assertTurnLease();

        // 6. Send confirmation to user via Kapso WhatsApp API
        let sendElapsedMs = 0;
        const deliveredV2 = v2DeliveryReceipt(result);
        let deliveryResult: WhatsAppDelivery | null = deliveredV2 ? { success: true, messageId: deliveredV2[0]! } : null;
        if (result.confirmation && !deliveredV2) {
          const sendStart = getNowMs();
          if (result.flow) {
            const flowLanguage = result.language || (user?.locale?.startsWith('en') ? 'en' : 'es');
            deliveryResult = await sendWhatsAppFlow({
              phoneNumberId,
              phoneNumber,
              bsuid,
              headerText: result.flow.headerText || null,
              bodyText: result.confirmation,
              footerText: result.flow.footerText || null,
              buttonText: result.flow.buttonText || (flowLanguage === 'en' ? 'Complete tasks' : 'Completar tareas'),
              flowId: result.flow.flowId,
              flowToken: result.flow.flowToken,
              flowAction: result.flow.flowAction || 'navigate',
              screen: result.flow.screen || 'TASK_SELECTION',
              flowData: result.flow.data,
              mode: result.flow.mode,
            });
          } else if (result.ctaUrl) {
            const ctaLanguage = result.language || (user?.locale?.startsWith('en') ? 'en' : 'es');
            deliveryResult = await sendWhatsAppCtaUrl({
              phoneNumberId,
              phoneNumber,
              bsuid,
              headerText: result.ctaHeader || null,
              bodyText: result.confirmation,
              buttonText: result.ctaButtonText || (ctaLanguage === 'en' ? 'Open link' : 'Abrir enlace'),
              url: result.ctaUrl,
            });
          } else if (result.buttons && Array.isArray(result.buttons) && result.buttons.length > 0) {
            deliveryResult = await sendWhatsAppQuickReplyButtons({
              phoneNumberId,
              phoneNumber,
              bsuid,
              headerText: result.buttonsHeader || null,
              bodyText: result.confirmation,
              footerText: result.buttonsFooter || null,
              buttons: result.buttons,
            });
          } else if (result.list && Array.isArray(result.list.sections) && result.list.sections.length > 0) {
            deliveryResult = await sendWhatsAppListMessage({
              phoneNumberId,
              phoneNumber,
              bsuid,
              headerText: result.list.headerText || null,
              bodyText: result.confirmation,
              footerText: result.list.footerText || null,
              buttonText: result.list.buttonText || (result.language === 'en' ? 'View options' : 'Ver opciones'),
              sections: result.list.sections,
            });
          } else {
            deliveryResult = await sendWhatsAppText({
              phoneNumberId,
              phoneNumber,
              bsuid,
              text: result.confirmation,
            });
          }
          sendElapsedMs = getNowMs() - sendStart;
        }

        if (result.confirmation && !deliveryResult?.success) {
          throw Object.assign(new Error('Reply delivery not confirmed'), { code: 'REPLY_DELIVERY_UNKNOWN' });
        }
        const totalElapsed = getNowMs() - startTime;
        logger.log(`[webhook req=${correlationId}] Turn delivered in ${totalElapsed}ms (queue: ${queueWaitMs}ms, dbPrep: ${userResolveMs + dbSaveUserMs + dbHistoryMs}ms, media: ${mediaElapsedMs}ms, ai: ${routeElapsedMs}ms, send: ${sendElapsedMs}ms)`);

        // 7. PERSIST ASSISTANT MESSAGE AND AWAIT
        await saveMessage({
          userId: user.id,
          phoneNumber: recipientIdentifier,
          role: 'assistant',
          messageId: deliveryResult?.success ? (deliveryResult.messageId || null) : null,
          content: result.confirmation ?? '',
          intent: result.intent,
          entities: { ...(result.entities || {}), _responseLanguage: result.language || (user?.locale?.startsWith('en') ? 'en' : 'es') },
        });

        // 8. Attachment-only observations are not durable user facts. Captioned
        // attachments can still contain trusted user text eligible for learning.
        if (!attachmentOnly && !deliveredV2) {
          withoutTurnLease(() => extractMemoryInBackground({
            userId: user.id,
            userText: currentUserText,
            assistantReply: result.confirmation ?? '',
            executionFacts: result.executionFacts || [],
            memoryDisposition: result.memoryDisposition || 'extract',
            learningCandidates: result.learningCandidates,
            learningCandidatesProvided: result.learningCandidatesProvided === true,
          }));
        } else {
          logger.log(`[memory-extractor req=${correlationId}] skipped ${deliveredV2 ? 'V2-delivered' : 'attachment-only'} turn`);
        }
        });
      });

    } catch (error) {
      logger.error(`[webhook req=${correlationId}] Process error:`, (error as { message?: string; code?: string }).message || error);
      throw error;
    }
  }

  return { markAsProcessed, isDuplicate, enqueueForUser, extractPhoneNumberId, extractContactInfo, isOutboundMessage, extractDeliveryStatuses, handleWebhook, processWebhookMessage };
}
