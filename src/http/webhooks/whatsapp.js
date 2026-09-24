import crypto from 'crypto';
import { clearWorkingMemory } from '../../agent/core/working-memory.js';
import { routeMessage } from '../../agent/orchestration/router.js';
import { sendWhatsAppText, sendWhatsAppCtaUrl, sendWhatsAppFlow, sendTypingIndicator, downloadMedia, normalizePhoneNumber } from '../../integrations/whatsapp/kapso-client.js';
import { saveMessage, getRecentMessages, isMessageAlreadyProcessed, getAssistantMessageById } from '../../infrastructure/database/messages.js';
import { getOrCreateUserByPhone, updateUserTimezone, touchUserLastActive } from '../../infrastructure/database/users.js';
import {
  supabase,
  updateReminderDeliveryStatus,
  acknowledgeReminder,
  acknowledgeRemindersByTaskId,
  updateReminder,
  updateTask,
} from '../../infrastructure/database/index.js';
import { extractMemoryInBackground } from '../../jobs/memory-extractor.js';
import { transcribeAudio } from '../../integrations/media/transcription.js';
import { processDocumentOrImage } from '../../integrations/media/document-processor.js';
import { detectTimezoneFromLocationText, detectTimezoneFromCoordinates, getNearestCityFromCoordinates } from '../../shared/time.js';
import { isIntradayRecurrence } from '../../shared/reminder-recurrence.js';

// In-memory dedup set for message IDs as fast-path optimization (DB is true source of truth).
const recentlyProcessed = new Set();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function markAsProcessed(messageId) {
  if (!messageId) return;
  recentlyProcessed.add(messageId);
  setTimeout(() => recentlyProcessed.delete(messageId), DEDUP_TTL_MS).unref?.();
}

export function isDuplicate(messageId) {
  if (!messageId) return false;
  if (recentlyProcessed.has(messageId)) return true;
  markAsProcessed(messageId);
  return false;
}

// Per-user in-flight promise queue to guarantee FIFO order across concurrent messages from the same user
const userQueueMap = new Map();

/**
 * Execute task in sequential order per user.
 */
export async function enqueueForUser(userIdOrPhone, taskFn) {
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
  currentPromise.finally(() => {
    if (userQueueMap.get(key) === currentPromise) {
      userQueueMap.delete(key);
    }
  });

  return currentPromise;
}

/**
 * Dynamically extract originating phoneNumberId (Sandbox vs Production) from Meta/Kapso payload.
 */
export function extractPhoneNumberId(payload) {
  if (!payload || typeof payload !== 'object') {
    return process.env.KAPSO_PHONE_NUMBER_ID || process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID || '1248246475047194';
  }

  const changeValue = payload.entry?.[0]?.changes?.[0]?.value || {};
  const metadata = changeValue.metadata || {};

  const id = payload.phone_number_id
    || metadata.phone_number_id
    || changeValue.phone_number_id
    || payload.conversation?.phone_number_id
    || payload.data?.phone_number_id
    || payload.message?.phone_number_id
    || process.env.KAPSO_PHONE_NUMBER_ID
    || process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID
    || '1248246475047194';

  return String(id).trim();
}

/**
 * Clean contact information separating E.164 phone numbers and BSUIDs.
 */
export function extractContactInfo(payload) {
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
export function isOutboundMessage(payload) {
  if (payload.message?.kapso?.direction === 'outbound') return true;
  if (payload.message?.direction === 'outbound') return true;
  if (payload.direction === 'outbound') return true;
  if (payload.message?.from_me === true || payload.from_me === true) return true;
  if (payload.message?.kapso?.origin === 'agent' || payload.message?.kapso?.origin === 'api') return true;
  if (payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from_me === true) return true;
  return false;
}

export function extractDeliveryStatuses(payload = {}) {
  const metaStatuses = (payload.entry || [])
    .flatMap((entry) => entry?.changes || [])
    .flatMap((change) => change?.value?.statuses || []);
  const directStatuses = Array.isArray(payload.statuses) ? payload.statuses : [];
  const message = payload.message || payload.data?.message || null;
  const kapsoStatus = message?.id && message?.kapso?.direction === 'outbound' && message?.kapso?.status
    ? [{ id: message.id, status: message.kapso.status, errors: message.errors || null }]
    : [];

  return [...metaStatuses, ...directStatuses, ...kapsoStatus]
    .filter((status) => status?.id && status?.status)
    .map((status) => ({
      deliveryId: status.id,
      deliveryStatus: String(status.status).toLowerCase(),
      errorDetails: status.errors || status.error || null,
    }));
}

export async function handleWebhook(req, res) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || crypto.randomUUID();
  const startTime = Date.now();

  // Acknowledge immediately. The configured Kapso/Meta webhook uses the
  // platform verification token during endpoint registration and does not
  // provide a separate POST-signing secret for this integration.
  res.status(200).send('OK');

  try {
    const body = req.body || {};

    // Reconcile provider delivery truth before ignoring status-only events.
    const deliveryStatuses = extractDeliveryStatuses(body);
    if (deliveryStatuses.length > 0) {
      const outcomes = await Promise.all(deliveryStatuses.map(async (status) => {
        if (status.deliveryStatus === 'failed') {
          console.warn(`[webhook req=${correlationId}] provider reported failed message delivery`);
        }
        try {
          if (await updateReminderDeliveryStatus(status)) return 'reminder';
          if (await getAssistantMessageById(status.deliveryId)) return 'conversation';
          // A callback can arrive before persistence or refer to another sender.
          // Unmatched is not proof of a failed reminder update or successful delivery.
          return 'unmatched';
        } catch (error) {
          console.warn(`[webhook req=${correlationId}] delivery status persistence failed:`, String(error?.message || error).slice(0, 180));
          return 'failed';
        }
      }));
      const count = (kind) => outcomes.filter((outcome) => outcome === kind).length;
      console.log(`[webhook req=${correlationId}] delivery status outcomes reminder=${count('reminder')} conversation=${count('conversation')} unmatched=${count('unmatched')} failed=${count('failed')}`);
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
        transitLagMs = Date.now() - msgEpochMs;
      }
    }
    console.log(`[webhook-ingress req=${correlationId}] Webhook recibido: ${new Date().toISOString()} | Message timestamp: ${rawMsgTs} (${msgIso}) | Transit lag: ${transitLagMs !== null ? `${transitLagMs}ms` : 'unknown'}`);

    // Idempotency: Ignore duplicate message IDs (Fast-path RAM check + Persistent DB check)
    if (isDuplicate(messageId) || (messageId && await isMessageAlreadyProcessed(messageId))) {
      console.log(`[webhook req=${correlationId}] Duplicate inbound messageId=${messageId} ignored.`);
      return;
    }

    // Must have at least one recipient identifier (phone or bsuid)
    if (!phoneNumber && !bsuid) {
      console.warn(`[webhook req=${correlationId}] Inbound message dropped: missing both phoneNumber and bsuid.`);
      return;
    }

    const recipientIdentifier = phoneNumber || bsuid;
    const phoneNumberId = extractPhoneNumberId(body);

    const queueEnqueueTime = Date.now();
    // Enqueue processing sequentially for this recipient to prevent context race conditions
    await enqueueForUser(recipientIdentifier, async () => {
      const queueWaitMs = Date.now() - queueEnqueueTime;

      // 1. Resolve User Record
      const tUser0 = Date.now();
      const user = await getOrCreateUserByPhone(recipientIdentifier, null, 'es-CO', displayName);
      const userResolveMs = Date.now() - tUser0;

      let messageText = message.text?.body || message.text || body.text || body.data?.text || '';
      const caption = message.caption || message.image?.caption || message.document?.caption || '';

      // Fast-path: WhatsApp Interactive Button Replies & Flow Submissions (Zero LLM Turn, Instant Execution)
      const interactiveObj = message.interactive || body.message?.interactive || body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive;

      // Handle WhatsApp Flow Completion (nfm_reply)
      if (interactiveObj?.type === 'nfm_reply' || interactiveObj?.nfm_reply) {
        const nfmReply = interactiveObj.nfm_reply || interactiveObj;
        const rawResponse = nfmReply.response_json || nfmReply.responseJson || '{}';
        let parsedData = {};
        try {
          parsedData = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : (rawResponse || {});
        } catch (e) {
          console.warn(`[webhook fast-path req=${correlationId}] Failed to parse Flow response_json:`, e.message);
        }

        const rawSelected = parsedData.selected_ids || parsedData.selected_tasks || [];
        const selectedIds = Array.isArray(rawSelected) ? rawSelected : (rawSelected ? [rawSelected] : []);

        if (selectedIds.length > 0) {
          const completedTasks = [];
          for (const taskId of selectedIds) {
            try {
              const res = await updateTask(taskId, { status: 'completed' }, user.id);
              if (res?.data || res?.id) {
                const taskRecord = res.data || res;
                completedTasks.push(taskRecord);
                await acknowledgeRemindersByTaskId(taskRecord.id, user.id);
              }
            } catch (err) {
              console.warn(`[webhook fast-path req=${correlationId}] Error completing task ${taskId} from flow:`, err.message);
            }
          }

          const isEnglishUser = Boolean(user?.locale?.startsWith('en'));
          let confirmText;
          if (completedTasks.length === 0) {
            confirmText = isEnglishUser
              ? '⚠️ The selected tasks could not be updated or were already completed.'
              : '⚠️ Las tareas seleccionadas no pudieron actualizarse o ya estaban completadas.';
          } else if (completedTasks.length === 1) {
            const t = completedTasks[0];
            confirmText = isEnglishUser
              ? `✅ *Task completed*\n\n• ${t.title || t.content || 'Task'}`
              : `✅ *Tarea completada*\n\n• ${t.title || t.content || 'Tarea'}`;
          } else {
            const taskLines = completedTasks.map((t) => `• ${t.title || t.content || 'Tarea'}`).join('\n');
            confirmText = isEnglishUser
              ? `✅ *${completedTasks.length} tasks completed*\n\n${taskLines}`
              : `✅ *${completedTasks.length} tareas completadas*\n\n${taskLines}`;
          }

          await saveMessage({
            userId: user.id,
            phoneNumber: recipientIdentifier,
            role: 'user',
            content: '[Flujo completado: tareas]',
            messageId: messageId || null,
            intent: 'task_complete_flow_submit',
            entities: { completedTaskIds: selectedIds },
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
            entities: { completedTaskIds: selectedIds },
          });

          console.log(`[webhook fast-path req=${correlationId}] Flow completed ${completedTasks.length}/${selectedIds.length} tasks in ${Date.now() - queueEnqueueTime}ms`);
          return;
        }
      }

      const buttonReply = interactiveObj?.button_reply || message.button_reply;
      if (buttonReply?.id) {
        const buttonId = String(buttonReply.id || '').trim();
        if (buttonId.startsWith('rem:ack:')) {
          const reminderId = buttonId.replace('rem:ack:', '').trim();
          const ackResult = await acknowledgeReminder(reminderId, user.id);
          if (ackResult?.task_id) {
            try {
              await updateTask(ackResult.task_id, { status: 'completed' }, user.id);
            } catch (taskErr) {
              console.warn(`[webhook fast-path req=${correlationId}] task completion cascade warning:`, taskErr.message);
            }
          }
          if (ackResult?.id && isIntradayRecurrence(ackResult.recurrence_rule)) {
            try {
              await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', ackResult.id);
            } catch (cancelErr) {
              console.warn(`[webhook fast-path req=${correlationId}] intraday recurrence cancel warning:`, cancelErr.message);
            }
          }
          try {
            clearWorkingMemory(user);
            if (phoneNumber) clearWorkingMemory(phoneNumber);
          } catch (memErr) {
            console.warn(`[webhook fast-path req=${correlationId}] clearWorkingMemory warning:`, memErr.message);
          }
          const isEnglishUser = Boolean(user?.locale?.startsWith('en'));
          const confirmText = isEnglishUser
            ? '✅ Great! I’ve marked this reminder as completed.'
            : '✅ ¡Excelente! He marcado este recordatorio como completado.';

          await saveMessage({
            userId: user.id,
            phoneNumber: recipientIdentifier,
            role: 'user',
            content: buttonReply.title || (isEnglishUser ? 'Done' : 'Listo'),
            messageId: messageId || null,
            intent: 'reminder_ack_click',
            entities: { reminderId },
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
            entities: { reminderId },
          });
          console.log(`[webhook fast-path req=${correlationId}] reminder ${reminderId} acknowledged via button reply in ${Date.now() - queueEnqueueTime}ms`);
          return;
        }

        if (buttonId.startsWith('rem:snooze:')) {
          const parts = buttonId.split(':');
          const minutes = Number(parts[2]) || 15;
          const reminderId = parts[3] ? parts.slice(3).join(':').trim() : '';
          const newSendAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
          await updateReminder(
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
          const isEnglishUser = Boolean(user?.locale?.startsWith('en'));
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
            entities: { reminderId, minutes, newSendAt },
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
            entities: { reminderId, minutes, newSendAt },
          });
          console.log(`[webhook fast-path req=${correlationId}] reminder ${reminderId} snoozed by ${minutes}m via button reply in ${Date.now() - queueEnqueueTime}ms`);
          return;
        }

        if (buttonReply.title && !messageText) {
          messageText = buttonReply.title;
        }
      }

      // Show typing indicator immediately
      if (messageId) {
        sendTypingIndicator(messageId, phoneNumberId).catch((err) => {
          console.warn(`[webhook req=${correlationId}] sendTypingIndicator background error:`, err?.message || err);
        });
      }

      // 2. Handle Multimodal Media (Audio, Images, PDFs, Documents, Location)
      const audioObj = message.audio || body.message?.audio;
      const isAudio = message.type === 'audio' || Boolean(audioObj);
      const isImage = message.type === 'image' || Boolean(message.image);
      const isDocument = message.type === 'document' || Boolean(message.document);
      const isLocation = message.type === 'location' || Boolean(message.location);

      let locationTz = null;
      let mediaElapsedMs = 0;
      let attachmentOnly = false;
      if (isLocation) {
        const loc = message.location || {};
        const lat = loc.latitude;
        const lon = loc.longitude;
        const locName = loc.name || loc.address || '';
        const nearest = getNearestCityFromCoordinates(lat, lon);
        const placeText = locName || (nearest ? `${nearest.city}, ${nearest.region || nearest.country}` : '');
        locationTz = detectTimezoneFromCoordinates(lat, lon) || (nearest?.tz || null) || detectTimezoneFromLocationText(locName);
        messageText = `[Ubicación compartida: ${placeText ? `${placeText} ` : ''}(lat ${lat}, lon ${lon})]`;
      } else if (isAudio && (audioObj?.id || message.id || audioObj?.media_url || audioObj?.url || audioObj?.download_url)) {
        const mediaStart = Date.now();
        const mediaId = audioObj?.id || message.id;
        const directMediaUrl = audioObj?.media_url || audioObj?.url || audioObj?.download_url || audioObj?.link || message?.media_url || body?.media_url || null;
        console.log(`[webhook req=${correlationId}] Downloading voice note mediaId=${mediaId}...`);
        const audioBlob = await downloadMedia(mediaId, phoneNumberId, directMediaUrl);
        if (audioBlob) {
          const mimeType = audioObj?.mime_type || 'audio/ogg';
          const transcribed = await transcribeAudio(audioBlob, mimeType);
          if (transcribed) {
            messageText = transcribed;
            console.log(`[webhook req=${correlationId}] Audio transcribed via Whisper: "${messageText}"`);
          }
        }
        mediaElapsedMs = Date.now() - mediaStart;
      } else if (isImage && (message.image?.id || message.id)) {
        const mediaStart = Date.now();
        const mediaId = message.image?.id || message.id;
        console.log(`[webhook req=${correlationId}] Downloading image mediaId=${mediaId}...`);
        const imageBuffer = await downloadMedia(mediaId, phoneNumberId);
        if (imageBuffer) {
          const mimeType = message.image?.mime_type || 'image/jpeg';
          const extracted = await processDocumentOrImage(imageBuffer, mimeType, caption);
          if (extracted) {
            attachmentOnly = !caption.trim();
            messageText = caption
              ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
              : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
            console.log(`[webhook req=${correlationId}] Image analyzed: "${messageText.slice(0, 90)}..."`);
          }
        }
        mediaElapsedMs = Date.now() - mediaStart;
      } else if (isDocument && (message.document?.id || message.id)) {
        const mediaStart = Date.now();
        const mediaId = message.document?.id || message.id;
        console.log(`[webhook req=${correlationId}] Downloading document mediaId=${mediaId}...`);
        const docBuffer = await downloadMedia(mediaId, phoneNumberId);
        if (docBuffer) {
          const mimeType = message.document?.mime_type || 'application/pdf';
          const extracted = await processDocumentOrImage(docBuffer, mimeType, caption);
          if (extracted) {
            attachmentOnly = !caption.trim();
            messageText = caption
              ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
              : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
            console.log(`[webhook req=${correlationId}] Document analyzed: "${messageText.slice(0, 90)}..."`);
          }
        }
        mediaElapsedMs = Date.now() - mediaStart;
      }

      if (!messageText && (isAudio || isImage || isDocument)) {
        const mediaLabel = isAudio ? 'audio' : (isImage ? 'imagen' : 'documento');
        const failureText = `No pude procesar ese ${mediaLabel} en este momento. No ejecuté ninguna acción basada en su contenido; puedes reenviarlo o escribir la instrucción en texto.`;
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

      // Extract WhatsApp quoted/replied message context (Swipe to Reply)
      const contextObj = message.context || body.message?.context || body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.context;
      const quotedText = contextObj?.quoted_content || contextObj?.body || contextObj?.text || contextObj?.message?.text?.body || contextObj?.message?.text || null;
      if (quotedText && typeof quotedText === 'string' && quotedText.trim().length > 0) {
        console.log(`[webhook req=${correlationId}] Quoted message detected: "${quotedText.slice(0, 60)}..."`);
        messageText = `[Respondiendo a: "${quotedText.trim()}"]\n${messageText}`;
      }

      const logContact = displayName ? `"${displayName}" (${recipientIdentifier})` : recipientIdentifier;
      console.log(`[webhook req=${correlationId}] Inbound from ${logContact}: "${messageText.slice(0, 90)}..."`);

      // Dynamic Timezone Resolution
      if (locationTz && user.timezone !== locationTz) {
        // High-confidence: Native WhatsApp GPS Location Pin
        console.log(`[webhook req=${correlationId}] Dynamic timezone switch via location pin: ${user.timezone} -> ${locationTz}`);
        await updateUserTimezone(user.id, locationTz);
        user.timezone = locationTz;
      } else {
        // Strict guard: only switch via conversational text if user EXPLICITLY commands a timezone change or states current residence,
        // and NEVER if the message is creating a task, list, reminder, or mentioning a future trip/flight/hotel.
        const isTaskOrFutureContext = /\b(lista|tarea|recuerdame|recuérdame|recordar|comprar|viaje a|viajar a|vuelo a|hotel|itinerario|ir a|visitar)\b/i.test(messageText);
        const isExplicitLocationDirective = /^(?:estoy viviendo en|ahora vivo en|me mud[eé] a|cambia(?:r)? mi zona horaria a|mi zona horaria es)\s+/i.test(messageText.trim()) ||
          /\b(?:físicamente me encuentro en|actualmente resido en)\b/i.test(messageText);

        if (!isTaskOrFutureContext && isExplicitLocationDirective) {
          const textTz = detectTimezoneFromLocationText(messageText);
          if (textTz && user.timezone !== textTz) {
            console.log(`[webhook req=${correlationId}] Dynamic timezone switch via explicit directive: ${user.timezone} -> ${textTz}`);
            await updateUserTimezone(user.id, textTz);
            user.timezone = textTz;
          }
        }
      }

      // 3. PERSIST USER MESSAGE FIRST AND AWAIT (Guarantees chronological order and DB-level deduplication)
      const tSave0 = Date.now();
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
      const dbSaveUserMs = Date.now() - tSave0;

      // If concurrent request won the DB insert on the same message_id, abort duplicate processing
      if (messageId && !savedUserMsg) {
        console.warn(`[webhook req=${correlationId}] Duplicate inbound messageId=${messageId} caught by DB unique constraint.`);
        return;
      }
      touchUserLastActive(user.id, recipientIdentifier);

      // 4. Fetch updated conversation history including this message. Typed
      // Working Memory is persisted in assistant entities, so a larger window
      // also survives process restarts without reconstructing identity from prose.
      const tHist0 = Date.now();
      const history = await getRecentMessages(recipientIdentifier, 40);
      const dbHistoryMs = Date.now() - tHist0;

      // 5. Route every turn through the canonical Hermes pipeline. A no-caption
      // attachment is explicitly marked so router-core can expose conversation.reply
      // only while keeping the extracted file content untrusted.
      const routeStart = Date.now();
      const inputModality = isImage ? 'image' : isDocument ? 'document' : isAudio ? 'audio' : isLocation ? 'location' : 'text';
      const result = await routeMessage(messageText, user, history, {
        correlationId,
        requestTimeMs,
        inputModality,
        attachmentOnly,
      });
      const routeElapsedMs = Date.now() - routeStart;

      // 6. Send confirmation to user via Kapso WhatsApp API
      let sendElapsedMs = 0;
      let deliveryResult = null;
      if (result.confirmation) {
        const sendStart = Date.now();
        if (result.flow) {
          const flowLanguage = result.language || (user?.locale?.startsWith('en') ? 'en' : 'es');
          try {
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
          } catch (flowError) {
            console.warn(`[webhook req=${correlationId}] Flow dispatch failed, falling back to text message:`, flowError.message);
            deliveryResult = await sendWhatsAppText({
              phoneNumberId,
              phoneNumber,
              bsuid,
              text: result.confirmation,
            });
          }
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
        } else {
          deliveryResult = await sendWhatsAppText({
            phoneNumberId,
            phoneNumber,
            bsuid,
            text: result.confirmation,
          });
        }
        sendElapsedMs = Date.now() - sendStart;
      }

      const totalElapsed = Date.now() - startTime;
      console.log(`[webhook req=${correlationId}] Turn delivered in ${totalElapsed}ms (queue: ${queueWaitMs}ms, dbPrep: ${userResolveMs + dbSaveUserMs + dbHistoryMs}ms, media: ${mediaElapsedMs}ms, ai: ${routeElapsedMs}ms, send: ${sendElapsedMs}ms)`);

      // 7. PERSIST ASSISTANT MESSAGE AND AWAIT
      await saveMessage({
        userId: user.id,
        phoneNumber: recipientIdentifier,
        role: 'assistant',
        messageId: deliveryResult?.success ? (deliveryResult.messageId || null) : null,
        content: result.confirmation ?? '',
        intent: result.intent,
        entities: result.entities ?? {},
      });

      // 8. Attachment-only observations are not durable user facts. Captioned
      // attachments can still contain trusted user text eligible for learning.
      if (!attachmentOnly) {
        extractMemoryInBackground({
          userId: user.id,
          userText: messageText,
          assistantReply: result.confirmation ?? '',
          executionFacts: result.executionFacts || [],
          memoryDisposition: result.memoryDisposition || 'extract',
        });
      } else {
        console.log(`[memory-extractor req=${correlationId}] skipped attachment-only turn`);
      }
    });

  } catch (error) {
    console.error(`[webhook req=${correlationId}] Process error:`, error.message || error);
  }
}
