import { TURN_INTENT_SCHEMA, getIntentActionsForDomain } from './intent-contracts.js';

// Provider-only projection. TURN_INTENT_SCHEMA remains the canonical contract.
// Groq strict subset: https://console.groq.com/docs/structured-outputs
function nullable(schema) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const result = { ...schema, type: [...new Set([...types, 'null'])] };
    if (schema.enum && !schema.enum.includes(null)) result.enum = [...schema.enum, null];
    return result;
  }
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
  // Match the resolver's required components. Minute, year and weekOffset keep
  // their existing deterministic defaults; inherit_context cannot create a new item.
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
    return branch;
  }) };
}

export function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  const action = schema.properties.actions.items;
  const domains = action.properties.domain.enum.filter((domain) => isAdmin || domain !== 'admin');
  action.properties.domain.enum = attachmentOnly ? ['conversation'] : domains;
  if (attachmentOnly) return strictProviderSchema(schema);

  // The generic branch excludes ALL reminder actions: it cannot bypass the
  // non-null schedule requirement by also matching reminder.create.
  const other = structuredClone(action);
  other.properties.domain.enum = domains.filter((domain) => domain !== 'reminder');
  const reminderOther = structuredClone(action);
  reminderOther.properties.domain.enum = ['reminder'];
  reminderOther.properties.action.enum = getIntentActionsForDomain('reminder').filter((name) => name !== 'create');
  const create = structuredClone(action);
  create.properties.domain.enum = ['reminder'];
  create.properties.action.enum = ['create'];
  create.required = [...create.required, 'content', 'schedule'];
  create.properties.schedule = reminderCreateSchedule(action.properties.schedule);
  schema.properties.actions.items = { anyOf: [create, reminderOther, other] };
  return strictProviderSchema(schema);
}

export function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== null)
    .map(([key, child]) => [key, stripStructuredNulls(child)]));
}
