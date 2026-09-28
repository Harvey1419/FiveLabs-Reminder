const ADVANCE_NOTICE_PREFIX = '🔔 [Aviso Previo] En ';
const ADVANCE_NOTICE_SEPARATOR = ' minutos: ';

export function buildAdvanceNoticeContent(baseContent, advanceMinutes) {
  const minutes = Number(advanceMinutes);
  const content = String(baseContent || '').trim();
  if (!Number.isInteger(minutes) || minutes <= 0 || !content) return null;
  return `${ADVANCE_NOTICE_PREFIX}${minutes}${ADVANCE_NOTICE_SEPARATOR}${content}`;
}

export function parseAdvanceNoticeContent(content) {
  const value = String(content || '');
  if (!value.startsWith(ADVANCE_NOTICE_PREFIX)) return null;

  const separatorIndex = value.indexOf(ADVANCE_NOTICE_SEPARATOR, ADVANCE_NOTICE_PREFIX.length);
  if (separatorIndex === -1) return null;

  const minutesText = value.slice(ADVANCE_NOTICE_PREFIX.length, separatorIndex).trim();
  const advanceMinutes = Number(minutesText);
  const baseContent = value.slice(separatorIndex + ADVANCE_NOTICE_SEPARATOR.length).trim();

  if (!Number.isInteger(advanceMinutes) || advanceMinutes <= 0 || !baseContent) return null;
  return { advanceMinutes, baseContent };
}

export function isAdvanceNoticeContent(content) {
  return Boolean(parseAdvanceNoticeContent(content));
}

export function belongsToMainReminder(notice, main) {
  if (!notice || !main) return false;

  // Canonical ownership for new rows: delivery effects belong to one primary reminder.
  if (notice.parent_reminder_id && main.id) {
    return String(notice.parent_reminder_id) === String(main.id);
  }

  // Legacy compatibility for rows created before parent_reminder_id was populated.
  // This is internal protocol reconciliation, never interpretation of user language.
  const parsed = parseAdvanceNoticeContent(notice.content);
  if (!parsed || parsed.baseContent !== main.content) return false;

  const noticeTime = new Date(notice.send_at || 0).getTime();
  const mainTime = new Date(main.send_at || 0).getTime();
  if (!Number.isFinite(noticeTime) || !Number.isFinite(mainTime)) return false;

  return noticeTime + (parsed.advanceMinutes * 60 * 1000) === mainTime;
}

export function getAdvanceNoticeMinutes(notice, main = null) {
  const parsed = parseAdvanceNoticeContent(notice?.content);
  if (parsed?.advanceMinutes) return parsed.advanceMinutes;

  if (main?.send_at && notice?.send_at) {
    const mainTime = new Date(main.send_at).getTime();
    const noticeTime = new Date(notice.send_at).getTime();
    const minutes = Math.round((mainTime - noticeTime) / 60000);
    if (Number.isInteger(minutes) && minutes > 0) return minutes;
  }

  return null;
}
