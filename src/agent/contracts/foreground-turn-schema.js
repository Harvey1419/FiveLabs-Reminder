import { TURN_INTENT_SCHEMA } from './intent-contracts.js';

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
      return [key, required.has(key) ? converted : { anyOf: [converted, { type: 'null' }] }];
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
  action.properties.schedule.description += ' For reminder.create this MUST be a non-null schedule containing the requested time. Use clarification.request instead of an incomplete creation. Each action must retain its own time.';
  action.properties.schedule.properties.clockMode.description = 'Use explicit_24h with hour 0..23, or explicit_am/explicit_pm/ambiguous_12h with hour 1..12. Never pair explicit_pm with hour 13..23. Preserve noon as 12 explicit_pm or 12 explicit_24h.';
  return strictProviderSchema(schema);
}

export function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== null)
    .map(([key, child]) => [key, stripStructuredNulls(child)]));
}
export const normalizeProviderTurnIntent = stripStructuredNulls;
