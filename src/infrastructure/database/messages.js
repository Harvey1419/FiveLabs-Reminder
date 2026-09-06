import { supabase } from './index.js';

/**
 * Persist a conversation turn with unique message_id deduplication support.
 * Failures are best-effort and never break the webhook.
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.phoneNumber
 * @param {'user'|'assistant'|'system'} params.role
 * @param {string} params.content
 * @param {string} [params.intent]
 * @param {object} [params.entities]
 * @param {string} [params.messageId]
 * @returns {Promise<object|null>}
 */
export async function saveMessage({ userId, phoneNumber, role, content, intent, entities, messageId = null }) {
  try {
    const payload = {
      phone_number: phoneNumber,
      role,
      content,
      intent: intent ?? null,
      entities: entities ?? null,
    };

    if (userId) {
      payload.user_id = userId;
    }
    if (messageId) {
      payload.message_id = messageId;
    }

    const { data, error } = await supabase
      .from('messages')
      .insert(payload)
      .select()
      .single();

    if (error) {
      // If error is unique constraint violation on message_id
      if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
        console.warn(`[messages] Duplicate inbound message_id "${messageId}" prevented by database unique constraint.`);
        return null;
      }
      console.error('saveMessage failed:', error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('saveMessage threw:', err);
    return null;
  }
}

/**
 * Check if a WhatsApp/Kapso messageId has already been recorded in the persistent database.
 * Survives process restarts and container reboots.
 *
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
export async function isMessageAlreadyProcessed(messageId) {
  if (!messageId || typeof messageId !== 'string') return false;

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id')
      .eq('message_id', messageId)
      .limit(1);

    if (!error && data && data.length > 0) {
      return true;
    }
  } catch (err) {
    console.warn('[messages] isMessageAlreadyProcessed error:', err.message);
  }

  return false;
}

/**
 * Fetch the most recent messages for a phone, ordered oldest → newest so
 * callers can splice them straight into a chat completion request. Returns
 * an empty array on any error (stateless fallback).
 *
 * @param {string} phone
 * @param {number} [limit=20]
 * @returns {Promise<Array<{role: 'user'|'assistant', content: string, entities: object|null, createdAt: string}>>}
 */
export async function getRecentMessages(phone, limit = 20) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('role, content, entities, created_at')
      .eq('phone_number', phone)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      console.error('getRecentMessages failed:', error);
      return [];
    }

    // Reverse to ASC (oldest → newest) and strip DB-only fields.
    return (data || [])
      .slice()
      .reverse()
      .map(({ role, content, entities, created_at: createdAt }) => ({ role, content, entities, createdAt }));
  } catch (err) {
    console.error('getRecentMessages threw:', err);
    return [];
  }
}

/**
 * Resolve the WhatsApp sender channel recorded on the inbound turn that
 * existed when a reminder was created. This lets any scheduler process
 * (local or deployed) deliver through the originating sandbox/production
 * number without adding a column to reminders.
 *
 * @param {string} phone
 * @param {string|null} [createdBefore]
 * @returns {Promise<string|null>}
 */
export async function getLatestInboundPhoneNumberId(phone, createdBefore = null) {
  if (!phone) return null;

  try {
    let query = supabase
      .from('messages')
      .select('entities, created_at')
      .eq('phone_number', phone)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(20);

    if (createdBefore) {
      query = query.lte('created_at', createdBefore);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('[messages] getLatestInboundPhoneNumberId failed:', error.message);
      return null;
    }

    for (const row of data || []) {
      const phoneNumberId = row?.entities?._transport?.phoneNumberId;
      if (phoneNumberId != null && String(phoneNumberId).trim()) {
        return String(phoneNumberId).trim();
      }
    }
  } catch (err) {
    console.warn('[messages] getLatestInboundPhoneNumberId threw:', err.message);
  }

  return null;
}
