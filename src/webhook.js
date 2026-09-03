import crypto from 'crypto';
import { routeMessage } from './ai/router.js';
import { sendWhatsAppText, sendWhatsAppCtaUrl, sendTypingIndicator, downloadMedia, normalizePhoneNumber } from './utils/kapso.js';
import { saveMessage, getRecentMessages, isMessageAlreadyProcessed } from './db/messages.js';
import { getOrCreateUserByPhone, updateUserTimezone, touchUserLastActive } from './db/users.js';
import { extractMemoryInBackground } from './workers/memoryExtractor.js';
import { transcribeAudio } from './services/transcriptionService.js';
import { processDocumentOrImage } from './services/documentService.js';
import { detectTimezoneFromLocationText, detectTimezoneFromCoordinates, getNearestCityFromCoordinates } from './utils/time.js';

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
 * Helper to verify webhook HMAC signature.
 */
export function verifyWebhookSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  try {
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const signature = signatureHeader.replace(/^sha256=/, '');
    return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Validate HMAC-SHA256 signature from X-Webhook-Signature header using raw body bytes.
 */
function verifySignature(req) {
  const secret = process.env.WEBHOOK_SECRET_KEY;
  const isProd = process.env.NODE_ENV === 'production';

  if (!secret) {
    // Fail-closed in production if secret is not configured
    if (isProd) {
      console.error('[webhook] ❌ Security violation: WEBHOOK_SECRET_KEY is missing in production environment.');
      return false;
    }
    return true; // Signature check disabled only in development/test
  }

  const signatureHeader = req.headers['x-webhook-signature'] || req.headers['x-hub-signature-256'];
  if (!signatureHeader) return false;

  const rawSig = signatureHeader.replace(/^sha256=/i, '').trim();
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    const a = Buffer.from(rawSig, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

export async function handleWebhook(req, res) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || crypto.randomUUID();
  const startTime = Date.now();

  // 1. Validate signature
  if (!verifySignature(req)) {
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd && !process.env.WEBHOOK_SECRET_KEY) {
      return res.status(500).send('Server Error: Webhook secret not configured');
    }
    console.warn(`[webhook req=${correlationId}] ❌ Rejected webhook: invalid signature.`);
    return res.status(401).send('Unauthorized: Invalid Signature');
  }

  // 2. Immediate HTTP 200 acknowledgment to Kapso to prevent retries
  res.status(200).send('OK');

  try {
    const body = req.body || {};

    // 3. Ignore delivery/read status updates
    const isStatusUpdate = Boolean(body.entry?.[0]?.changes?.[0]?.value?.statuses || body.statuses || body.status);
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
    if (rawMsgTs) {
      const msgEpochMs = String(rawMsgTs).length <= 10 ? Number(rawMsgTs) * 1000 : Number(rawMsgTs);
      if (!isNaN(msgEpochMs)) {
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
      let audioElapsedMs = 0;
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
        const audioStart = Date.now();
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
        audioElapsedMs = Date.now() - audioStart;
      } else if (isImage && (message.image?.id || message.id)) {
        const mediaId = message.image?.id || message.id;
        console.log(`[webhook req=${correlationId}] Downloading image mediaId=${mediaId}...`);
        const imageBuffer = await downloadMedia(mediaId, phoneNumberId);
        if (imageBuffer) {
          const mimeType = message.image?.mime_type || 'image/jpeg';
          const extracted = await processDocumentOrImage(imageBuffer, mimeType, caption);
          if (extracted) {
            messageText = caption
              ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
              : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
            console.log(`[webhook req=${correlationId}] Image analyzed: "${messageText.slice(0, 90)}..."`);
          }
        }
      } else if (isDocument && (message.document?.id || message.id)) {
        const mediaId = message.document?.id || message.id;
        console.log(`[webhook req=${correlationId}] Downloading document mediaId=${mediaId}...`);
        const docBuffer = await downloadMedia(mediaId, phoneNumberId);
        if (docBuffer) {
          const mimeType = message.document?.mime_type || 'application/pdf';
          const extracted = await processDocumentOrImage(docBuffer, mimeType, caption);
          if (extracted) {
            messageText = caption
              ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
              : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
            console.log(`[webhook req=${correlationId}] Document analyzed: "${messageText.slice(0, 90)}..."`);
          }
        }
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
        console.log(`[webhook req=${correlationId}] Dynamic timezone switch via location pin: ${user.timezone} -> ${locationTz}`);
        await updateUserTimezone(user.id, locationTz);
        user.timezone = locationTz;
      } else {
        const isTravelPhrase = /\b(estoy en|llegue a|llegué a|viaje a|viajé a|me mude a|me mudé a|ahora en|desde|ubicado en|ando por|de viaje en|de viaje por|visitando|me encuentro en|viviendo en|radicado en|actualmente en|pasando por)\b/i.test(messageText);
        const textTz = detectTimezoneFromLocationText(messageText);
        if (textTz && isTravelPhrase && user.timezone !== textTz) {
          console.log(`[webhook req=${correlationId}] Dynamic timezone switch via conversational text: ${user.timezone} -> ${textTz}`);
          await updateUserTimezone(user.id, textTz);
          user.timezone = textTz;
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
      });
      const dbSaveUserMs = Date.now() - tSave0;

      // If concurrent request won the DB insert on the same message_id, abort duplicate processing
      if (messageId && !savedUserMsg) {
        console.warn(`[webhook req=${correlationId}] Duplicate inbound messageId=${messageId} caught by DB unique constraint.`);
        return;
      }
      touchUserLastActive(user.id, recipientIdentifier);

      // 4. Fetch updated conversation history including this message
      const tHist0 = Date.now();
      const history = await getRecentMessages(recipientIdentifier, 10);
      const dbHistoryMs = Date.now() - tHist0;

      // 5. Route to AI with full batch & natural reply generation
      const routeStart = Date.now();
      const result = await routeMessage(messageText, user, history, { correlationId });
      const routeElapsedMs = Date.now() - routeStart;

      // 6. Send confirmation to user via Kapso WhatsApp API
      let sendElapsedMs = 0;
      if (result.confirmation) {
        const sendStart = Date.now();
        if (result.ctaUrl) {
          await sendWhatsAppCtaUrl({
            phoneNumberId,
            phoneNumber,
            bsuid,
            headerText: result.ctaHeader || '📅 Google Calendar',
            bodyText: result.confirmation,
            buttonText: result.ctaButtonText || '🔗 Conectar',
            url: result.ctaUrl,
          });
        } else {
          await sendWhatsAppText({
            phoneNumberId,
            phoneNumber,
            bsuid,
            text: result.confirmation,
          });
        }
        sendElapsedMs = Date.now() - sendStart;
      }

      const totalElapsed = Date.now() - startTime;
      console.log(`[webhook req=${correlationId}] Turn delivered in ${totalElapsed}ms (queue: ${queueWaitMs}ms, dbPrep: ${userResolveMs + dbSaveUserMs + dbHistoryMs}ms, audio: ${audioElapsedMs}ms, ai: ${routeElapsedMs}ms, send: ${sendElapsedMs}ms)`);

      // 7. PERSIST ASSISTANT MESSAGE AND AWAIT
      await saveMessage({
        userId: user.id,
        phoneNumber: recipientIdentifier,
        role: 'assistant',
        content: result.confirmation ?? '',
        intent: result.intent,
        entities: result.entities ?? {},
      });

      // 8. Trigger persistent memory extraction in background
      extractMemoryInBackground({
        userId: user.id,
        userText: messageText,
        assistantReply: result.confirmation ?? '',
      });
    });

  } catch (error) {
    console.error(`[webhook req=${correlationId}] Process error:`, error.message || error);
  }
}
