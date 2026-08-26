import crypto from 'crypto';
import { routeMessage } from './ai/router.js';
import { sendWhatsAppText, sendTypingIndicator, downloadMedia, normalizePhoneNumber } from './utils/kapso.js';
import { saveMessage, getRecentMessages } from './db/messages.js';
import { getOrCreateUserByPhone, updateUserTimezone } from './db/users.js';
import { extractMemoryInBackground } from './workers/memoryExtractor.js';
import { transcribeAudio } from './services/transcriptionService.js';
import { processDocumentOrImage } from './services/documentService.js';
import { detectTimezoneFromLocationText, detectTimezoneFromCoordinates } from './utils/time.js';

// In-memory dedup set for message IDs we've already processed.
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

/**
 * Validate HMAC-SHA256 signature from X-Webhook-Signature header using raw body bytes.
 */
function verifySignature(req) {
  const secret = process.env.WEBHOOK_SECRET_KEY;
  if (!secret) return true; // Signature check disabled if secret is not set

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
 * Extract clean contact information separating E.164 phone numbers and BSUIDs.
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
  const startTime = Date.now();

  // 1. Validate signature if configured
  if (!verifySignature(req)) {
    console.warn('[webhook] ❌ Rejected webhook: invalid X-Webhook-Signature.');
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

    // Idempotency: Ignore duplicate message IDs
    if (isDuplicate(messageId)) {
      return;
    }

    // Must have at least one recipient identifier (phone or bsuid)
    if (!phoneNumber && !bsuid) {
      console.warn('[webhook] Inbound message dropped: missing both phoneNumber and bsuid.');
      return;
    }

    const recipientIdentifier = phoneNumber || bsuid;
    const configuredPhoneId = process.env.KAPSO_PHONE_NUMBER_ID || '1248246475047194';
    // Always use configured production phone ID, ignoring incoming sandbox tags
    const phoneNumberId = (body.phone_number_id === '597907523413541' || body.conversation?.phone_number_id === '597907523413541')
      ? configuredPhoneId
      : (process.env.KAPSO_PHONE_NUMBER_ID || body.phone_number_id || '1248246475047194');

    // Concurrently pre-fetch user profile & conversation history while media is downloading & transcribing
    const userAndHistoryPromise = Promise.all([
      getOrCreateUserByPhone(recipientIdentifier, null, 'es-CO', displayName),
      getRecentMessages(recipientIdentifier, 10),
    ]);

    let messageText = message.text?.body || message.text || body.text || body.data?.text || '';
    const caption = message.caption || message.image?.caption || message.document?.caption || '';

    // Show typing indicator immediately so the user sees "Escribiendo..." during media download & processing
    if (messageId) {
      sendTypingIndicator(messageId, phoneNumberId).catch((err) => {
        console.warn('[webhook] sendTypingIndicator background error:', err?.message || err);
      });
    }

    // 6. Handle Multimodal Media (Audio, Images, PDFs, Documents, Location)
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
      locationTz = detectTimezoneFromCoordinates(lat, lon) || detectTimezoneFromLocationText(locName);
      messageText = `[Ubicación compartida: ${locName ? `${locName} ` : ''}(lat ${lat}, lon ${lon})]`;
    } else if (isAudio && (audioObj?.id || message.id || audioObj?.media_url || audioObj?.url)) {
      const audioStart = Date.now();
      const mediaId = audioObj?.id || message.id;
      const directMediaUrl = audioObj?.media_url || audioObj?.url || audioObj?.link || null;
      console.log(`[webhook] Downloading voice note mediaId=${mediaId} directUrl=${Boolean(directMediaUrl)}...`);
      const audioBuffer = await downloadMedia(mediaId, phoneNumberId, directMediaUrl);
      if (audioBuffer) {
        const mimeType = audioObj?.mime_type || 'audio/ogg';
        const transcribed = await transcribeAudio(audioBuffer, mimeType);
        if (transcribed) {
          messageText = transcribed;
          console.log(`[webhook] Audio transcribed via Whisper: "${messageText}"`);
        }
      }
      audioElapsedMs = Date.now() - audioStart;
    } else if (isImage && (message.image?.id || message.id)) {
      const mediaId = message.image?.id || message.id;
      console.log(`[webhook] Downloading image mediaId=${mediaId}...`);
      const imageBuffer = await downloadMedia(mediaId, phoneNumberId);
      if (imageBuffer) {
        const mimeType = message.image?.mime_type || 'image/jpeg';
        const extracted = await processDocumentOrImage(imageBuffer, mimeType, caption);
        if (extracted) {
          messageText = caption
            ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
            : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
          console.log(`[webhook] Image analyzed: "${messageText.slice(0, 90)}..."`);
        }
      }
    } else if (isDocument && (message.document?.id || message.id)) {
      const mediaId = message.document?.id || message.id;
      console.log(`[webhook] Downloading document mediaId=${mediaId}...`);
      const docBuffer = await downloadMedia(mediaId, phoneNumberId);
      if (docBuffer) {
        const mimeType = message.document?.mime_type || 'application/pdf';
        const extracted = await processDocumentOrImage(docBuffer, mimeType, caption);
        if (extracted) {
          messageText = caption
            ? `${caption}\n\n<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`
            : `<untrusted_attachment_content>\n${extracted}\n</untrusted_attachment_content>`;
          console.log(`[webhook] Document analyzed: "${messageText.slice(0, 90)}..."`);
        }
      }
    }

    if (!messageText) {
      return;
    }

    const logContact = displayName ? `"${displayName}" (${recipientIdentifier})` : recipientIdentifier;
    console.log(`[webhook] Inbound from ${logContact}: "${messageText.slice(0, 90)}..."`);

    // Await pre-fetched User Profile + Conversation History (resolved concurrently during media download)
    const [user, history] = await userAndHistoryPromise;

    // Dynamic Timezone Resolution: WhatsApp Location Pin or Conversational Travel Text
    if (locationTz && user.timezone !== locationTz) {
      console.log(`[webhook] Dynamic timezone switch via location pin: ${user.timezone} -> ${locationTz}`);
      await updateUserTimezone(user.id, locationTz);
      user.timezone = locationTz;
    } else {
      const isTravelPhrase = /\b(estoy en|llegue a|llegué a|viaje a|viajé a|me mude a|me mudé a|ahora en|desde|ubicado en|ando por|de viaje en|de viaje por|visitando)\b/i.test(messageText);
      const textTz = detectTimezoneFromLocationText(messageText);
      if (textTz && isTravelPhrase && user.timezone !== textTz) {
        console.log(`[webhook] Dynamic timezone switch via conversational text: ${user.timezone} -> ${textTz}`);
        await updateUserTimezone(user.id, textTz);
        user.timezone = textTz;
      }
    }

    // Save user message in background
    saveMessage({
      userId: user.id,
      phoneNumber: recipientIdentifier,
      role: 'user',
      content: messageText,
    }).catch(err => console.error('saveMessage(user) failed:', err));

    // Route to AI with full batch & natural reply generation
    const routeStart = Date.now();
    const result = await routeMessage(messageText, user, history);
    const routeElapsedMs = Date.now() - routeStart;

    // Send confirmation to user via Kapso WhatsApp API
    let sendElapsedMs = 0;
    if (result.confirmation) {
      const sendStart = Date.now();
      await sendWhatsAppText({
        phoneNumberId,
        phoneNumber,
        bsuid,
        text: result.confirmation,
      });
      sendElapsedMs = Date.now() - sendStart;
    }

    const totalElapsed = Date.now() - startTime;
    console.log(`[webhook] Turn delivered in ${totalElapsed}ms (audio: ${audioElapsedMs}ms, ai: ${routeElapsedMs}ms, send: ${sendElapsedMs}ms)`);

    // Persist assistant message in background
    saveMessage({
      userId: user.id,
      phoneNumber: recipientIdentifier,
      role: 'assistant',
      content: result.confirmation ?? '',
      intent: result.intent,
      entities: result.entities ?? {},
    }).catch(err => console.error('saveMessage(assistant) failed:', err));

    // Trigger persistent memory extraction in background
    extractMemoryInBackground({
      userId: user.id,
      userText: messageText,
      assistantReply: result.confirmation ?? '',
    });

  } catch (error) {
    console.error('[webhook] Process error:', error.message || error);
  }
}
