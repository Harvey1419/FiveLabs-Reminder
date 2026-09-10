import { TURN_INTENT_SCHEMA, getIntentActionsForDomain } from './intent-contracts.js';

// Provider-only projection. TURN_INTENT_SCHEMA remains the canonical contract.
// Groq strict subset: https://console.groq.com/docs/structured-outputs
function nullable(schema) {
  // Keep enum/range constraints in a typed non-null branch. Combined nullable
  // types cause discriminator ambiguity and inconsistent numeric constraints
  // at the Groq boundary; the explicit union represents the same contract.
  return { anyOf: [schema, { type: 'null' }] };
}

function strictProviderSchema(schema) {
  const node = structuredClone(schema);
  // Enforced by validateTurnIntent, not supported by Groq's grammar.
  delete node.uniqueItems;
  if (node.items) node.items = strictProviderSchema(node.items);
  if (node.anyOf) node.anyOf = node.anyOf.map(strictProviderSchema);
  if (node.$defs) node.$defs = Object.fromEntries(Object.entries(node.$defs).map(([key, value]) => [key, strictProviderSchema(value)]));
  if (node.properties) {
    const required = new Set(node.required || []);
    node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => {
      const converted = strictProviderSchema(value);
      return [key, required.has(key) ? converted : nullable(converted)];
    }));
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  return node;
}

function reminderCreateSchedule(canonical) {
  // Match the resolver's required components and clock ranges. Minute, year
  // and weekOffset retain their existing defaults; creation cannot inherit time.
  const components = {
    relative_offset: ['offsetMinutes'],
    relative_day_time: ['dayOffset', 'hour'],
    calendar_date_time: ['month', 'day', 'hour'],
    weekday_time: ['weekday', 'hour'],
    local_time: ['hour'],
  };
  return { anyOf: Object.entries(components).map(([kind, fields]) => {
    const branch = structuredClone(canonical);
    branch.properties.kind.enum = [kind];
    branch.required = ['kind', ...fields];
    if (fields.includes('hour')) {
      branch.anyOf = [
        { modes: ['explicit_24h'], minimum: 0, maximum: 23 },
        { modes: ['explicit_am', 'explicit_pm', 'ambiguous_12h'], minimum: 1, maximum: 12 },
      ].map(({ modes, minimum, maximum }) => {
        const clock = structuredClone(branch);
        // Shared enums remain enforced by the enclosing schedule object.
        // Only clockMode discriminates its nested union.
        for (const property of Object.values(clock.properties)) delete property.enum;
        clock.properties.clockMode.enum = modes;
        clock.properties.hour = { ...clock.properties.hour, minimum, maximum };
        clock.required = [...clock.required, 'clockMode'];
        return clock;
      });
    }
    return branch;
  }) };
}

export function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  const action = schema.properties.actions.items;
  const domains = action.properties.domain.enum.filter((domain) => isAdmin || domain !== 'admin');
  action.properties.domain.enum = attachmentOnly ? ['conversation'] : domains;
  if (attachmentOnly) return strictProviderSchema(schema);

  const other = structuredClone(action);
  other.properties.domain.enum = domains.filter((domain) => domain !== 'reminder');
  const reminder = structuredClone(action);
  reminder.properties.domain.enum = ['reminder'];
  const reminderOther = structuredClone(action);
  // The enclosing object enforces domain=reminder. The nested action union
  // has a single discriminator with disjoint values, not overlapping domains.
  reminderOther.properties.domain = { type: 'string' };
  reminderOther.properties.action.enum = getIntentActionsForDomain('reminder').filter((name) => name !== 'create');
  const create = structuredClone(action);
  create.properties.domain = { type: 'string' };
  create.properties.action.enum = ['create'];
  create.required = [...create.required, 'content', 'schedule'];
  create.properties.schedule = reminderCreateSchedule(action.properties.schedule);
  reminder.anyOf = [create, reminderOther];
  schema.properties.actions.items = { anyOf: [reminder, other] };
  return strictProviderSchema(schema);
}

export function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== null)
    .map(([key, child]) => [key, stripStructuredNulls(child)]));
}
