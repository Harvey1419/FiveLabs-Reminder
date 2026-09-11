import {
  TURN_INTENT_SCHEMA,
  getCanonicalOperations,
  parseCanonicalOperation,
} from './intent-contracts.js';

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

export function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false, pendingIntentActive = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  if (pendingIntentActive) {
    schema.required = [...new Set([...(schema.required || []), 'pendingIntentEffect'])];
  }
  const action = schema.properties.actions.items;
  const domains = attachmentOnly
    ? ['conversation']
    : action.properties.domain.enum.filter((domain) => isAdmin || domain !== 'admin');

  // Groq rejects the polymorphic unions needed to condition action on domain.
  // A single qualified enum preserves that relationship without a union or a
  // Cartesian product. Node projects it back to canonical domain/action below.
  const { domain: _domain, action: _action, ...sharedProperties } = action.properties;
  action.properties = {
    operation: {
      type: 'string',
      enum: getCanonicalOperations({ domains }),
      description: 'Exact qualified canonical operation. Domain/action are inseparable. A request for current operational content or status requires the matching live read (for example task.list), never conversation.reply.',
    },
    ...sharedProperties,
  };
  action.required = ['operation'];
  action.properties.schedule.description += ' A complete reminder.create needs a usable schedule. If part is missing, keep known components on the partial action, declare missingFields and put the clarification question on that action; at most one clarification.request may accompany the coherent pending intent. Each action retains its own known date/time components.';
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

/** Convert the provider-only qualified operation into canonical TurnIntent. */
export function projectStructuredTurnIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.actions)) return value;
  return {
    ...value,
    actions: value.actions.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.operation === undefined) return item;
      const operation = String(item.operation || '').trim().toLowerCase();
      const parts = operation.split('.');
      // Known operations use the registry. Unknown but structurally qualified
      // values are still split so canonical validation can reject the exact
      // domain/action pair; no natural-language interpretation occurs here.
      const parsed = parseCanonicalOperation(operation)
        || (parts.length === 2 && parts.every(Boolean) ? { domain: parts[0], action: parts[1] } : null);
      if (!parsed) return { ...item };
      const { operation: _operation, ...fields } = item;
      return { ...fields, ...parsed };
    }),
  };
}
