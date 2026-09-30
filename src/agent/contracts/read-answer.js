/** A semantic presentation request, never model-provided operational values. */
export const READ_ANSWER_OPERATIONS = Object.freeze({
  'task.list': Object.freeze({ tool: 'manage_task', action: 'list' }),
  'reminder.list': Object.freeze({ tool: 'manage_reminder', action: 'list' }),
  'calendar.list': Object.freeze({ tool: 'manage_google_calendar', action: 'list_events' }),
  'calendar.search': Object.freeze({ tool: 'manage_google_calendar', action: 'search_events' }),
  'calendar.next': Object.freeze({ tool: 'manage_google_calendar', action: 'next_event' }),
  'project.list': Object.freeze({ tool: 'manage_project', action: 'list' }),
  'entity.list': Object.freeze({ tool: 'manage_entity', action: 'list' }),
});

const FIELDS = Object.freeze(['title', 'description', 'status', 'schedule']);
export const READ_ANSWER_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  description: 'Concise answer to a question about a current record or count. Always include its authoritative read in actions. Node fills values from that read only. Never write an operational answer in conversation.reply or supply amounts here. Omit for an explicitly requested full list. A monetary value stored in a title is reported as recorded, never treated as a payment or recalculated balance.',
  properties: {
    actionIndex: { type: 'integer', minimum: 0, maximum: 11, description: 'Zero-based index of the source read in actions, including any conversation actions in that indexing.' },
    mode: { type: 'string', enum: ['records', 'count'], description: 'records=report stored fields; count=count matching records, not monetary amounts. No arithmetic over prose or historical values.' },
    fields: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: FIELDS }, description: 'Fields to report in records mode. Identity and actual status are always retained. Omit for count. schedule=the recorded date/time, not a model-computed date.' },
  },
  required: ['actionIndex', 'mode'],
});

function invalid(error) {
  return { valid: false, errorCode: 'INVALID_READ_ANSWER', error };
}

/** Checks structure and operation identity only. It never sees user prose. */
export function validateReadAnswer(value, actions) {
  if (value === undefined || value === null) return { valid: true, readAnswer: null };
  if (typeof value !== 'object' || Array.isArray(value)) return invalid('readAnswer debe ser un objeto.');
  if (Object.keys(value).some((key) => !Object.hasOwn(READ_ANSWER_SCHEMA.properties, key))) {
    return invalid('readAnswer no admite texto de respuesta, valores ni campos desconocidos.');
  }
  if (!Number.isInteger(value.actionIndex) || value.actionIndex < 0 || value.actionIndex >= actions.length) {
    return invalid('readAnswer debe referenciar una acción existente.');
  }
  const source = actions[value.actionIndex];
  if (!Object.hasOwn(READ_ANSWER_OPERATIONS, `${source.domain}.${source.action}`)) {
    return invalid('readAnswer solo admite lecturas de registros operativos, no conversación, memoria ni mutaciones.');
  }
  if (!['records', 'count'].includes(value.mode)) return invalid('Modo de respuesta de lectura no soportado.');
  if (value.fields != null && (!Array.isArray(value.fields) || value.fields.length < 1
    || value.fields.length > FIELDS.length || new Set(value.fields).size !== value.fields.length
    || value.fields.some((field) => !FIELDS.includes(field)))) {
    return invalid('Campos de lectura no válidos.');
  }
  if (value.mode === 'count' && value.fields != null) return invalid('Un conteo no lleva campos de registros.');
  return {
    valid: true,
    readAnswer: {
      actionIndex: value.actionIndex,
      mode: value.mode,
      ...(value.mode === 'records' ? { fields: [...(value.fields || ['title', 'status'])] } : {}),
    },
  };
}
