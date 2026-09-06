const REMINDER_SCHEDULE_FIELDS = new Set(['main_time', 'advance_minutes']);

/** Render a typed clarification without trusting provider-authored permission prose. */
export function formatAssistantClarification(clarification, language = 'es') {
  if (clarification?.kind !== 'reminder_schedule') return '';
  const missingFields = new Set(
    (Array.isArray(clarification.missingFields) ? clarification.missingFields : [])
      .filter((field) => REMINDER_SCHEDULE_FIELDS.has(field)),
  );
  if (missingFields.size === 0) return '';

  const needsMainTime = missingFields.has('main_time');
  const needsAdvance = missingFields.has('advance_minutes');

  if (language === 'en') {
    if (needsMainTime && needsAdvance) {
      return 'What time is the appointment, and how far in advance would you like me to remind you?';
    }
    if (needsMainTime) return 'What time is the appointment?';
    return 'How far in advance would you like me to remind you?';
  }

  if (needsMainTime && needsAdvance) {
    return '¿A qué hora es la cita y con cuánto tiempo de anticipación quieres que te avise?';
  }
  if (needsMainTime) return '¿A qué hora es la cita?';
  return '¿Con cuánto tiempo de anticipación quieres que te avise?';
}
