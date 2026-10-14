export interface ClarificationValidation {
  errorCode?: string | undefined; requiresClarification?: unknown; error?: string | null | undefined;
}
export interface AssistantClarification { kind?: unknown; missingFields?: unknown }

const REMINDER_SCHEDULE_FIELDS = new Set(['main_time', 'advance_minutes']);

const INPUT_ERRORS: Readonly<Record<string, readonly [string, string, string]>> = Object.freeze({
  MISSING_CONTENT: ['content', 'What should it say?', '¿Cuál es el contenido?'],
  MISSING_TITLE: ['content', 'What is the title?', '¿Cuál es el título?'],
  MISSING_TARGET: ['target', 'Which item do you mean?', '¿A qué elemento te refieres?'],
  MISSING_SCHEDULE: ['schedule', 'On what date and at what time?', '¿Para qué fecha y hora?'],
  MISSING_CLOCK_TIME: ['time', 'At what time?', '¿A qué hora?'],
  MISSING_CALENDAR_DATE: ['date', 'On what date?', '¿Para qué fecha?'],
  AMBIGUOUS_CLOCK_TIME: ['time', 'Is that AM or PM?', '¿Es de la mañana o de la tarde?'],
});

/** Validation codes describe missing data; natural language never controls execution. */
export function pendingInputForValidation(validation: ClarificationValidation, language = 'es') {
  const entry = INPUT_ERRORS[validation.errorCode as string];
  if (entry) return { fields: [entry[0]], question: entry[language === 'en' ? 1 : 2] };
  if (!validation.requiresClarification) return null;
  return { fields: [], question: validation.error || (language === 'en' ? 'Could you clarify the missing information?' : '¿Puedes aclarar la información que falta?') };
}

/** Render a typed clarification without trusting provider-authored permission prose. */
export function formatAssistantClarification(clarification: AssistantClarification | null | undefined, language = 'es') {
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
