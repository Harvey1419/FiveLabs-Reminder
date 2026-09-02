import { supabase } from './index.js';

/**
 * Persist a single conversation turn. Best-effort: any failure is logged
 * and surfaced as a falsy return value so the webhook never breaks on a
 * persistence error.
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.phoneNumber
 * @param {'user'|'assistant'|'system'} params.role
 * @param {string} params.content
 * @param {string} [params.intent]
 * @param {object} [params.entities]
 * @returns {Promise<object|null>}
 */
/**
 * Persist a single conversation turn with unique message_id deduplication support.
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
 * @returns {Promise<Array<{role: 'user'|'assistant', content: string}>>}
 */
export async function getRecentMessages(phone, limit = 20) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('role, content, created_at')
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
      .map(({ role, content }) => ({ role, content }));
  } catch (err) {
    console.error('getRecentMessages threw:', err);
    return [];
  }
}
