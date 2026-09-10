import { TURN_INTENT_SCHEMA, getIntentActionsForDomain } from './intent-contracts.js';

// Provider-only projection: the canonical schema and deterministic action
// prerequisites remain authoritative. Avoid polymorphic object unions, whose
// compilation/generation was rejected by the actual Groq endpoint.
function strictProviderSchema(schema) {
  const node = structuredClone(schema);
  delete node.uniqueItems;
  if (node.items) node.items = strictProviderSchema(node.items);
  if (node.properties) {
    const required = new Set(node.required || []);
    node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => {
      const converted = strictProviderSchema(value);
      if (!required.has(key)) {
        converted.type = [converted.type, 'null'];
        if (converted.enum) converted.enum = [...converted.enum, null];
      }
      return [key, converted];
    }));
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  return node;
}

export function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  const action = schema.properties.actions.items;
  action.properties.domain.enum = attachmentOnly ? ['conversation'] : action.properties.domain.enum.filter((domain) => isAdmin || domain !== 'admin');
  action.properties.action = {
    type: 'string',
    enum: [...new Set(action.properties.domain.enum.flatMap(getIntentActionsForDomain))],
    description: 'Unqualified operation only, such as create or reply. domain is separate: use domain=reminder and action=create, never action=reminder.create.',
  };
  action.properties.schedule.description += ' For reminder.create this MUST be a non-null schedule containing the requested time. Use clarification.request instead of an incomplete creation. Each action must retain its own time.';
  action.properties.schedule.properties.dayOffset.description = 'Number of local calendar days from the current message date: 0=today, 1=tomorrow, 2=day after tomorrow. When a day is shared by multiple requests, repeat that dayOffset in every applicable schedule; never reset it to 0 merely because the day appears in a preceding clause.';
  action.properties.schedule.properties.offsetMinutes.description = 'Duration from now, only for relative_offset. For every other kind use null. Do not compute a duration instead of preserving the requested calendar day and clock time.';
  for (const field of ['schedule', 'endSchedule']) {
    // Explicit 12h and 24h clocks are semantically equivalent. Ask Hermes for
    // one canonical representation instead of letting the provider mix them.
    // Ambiguous clocks remain ambiguous; Node never guesses AM/PM here.
    action.properties[field].properties.clockMode = {
      type: 'string', enum: ['explicit_24h', 'ambiguous_12h'],
      description: 'For an explicit AM/PM or 24h time, output hour 0..23 and explicit_24h (3 PM = 15, noon = 12, midnight = 0). For a genuinely ambiguous 12h time keep hour 1..12 and ambiguous_12h. Do not invent AM/PM.',
    };
  }
  return strictProviderSchema(schema);
}

export function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== null)
    .map(([key, child]) => [key, stripStructuredNulls(child)]));
}
