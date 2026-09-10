import { TURN_INTENT_SCHEMA, getIntentActionsForDomain } from './intent-contracts.js';

// This projection is a wire contract, not a second semantic authority. Groq's
// object unions require a single, disjoint discriminator. Canonical fields are
// preserved verbatim; the provider-only tags are checked and removed on ingress.
const TAG = '_variant';
const CANONICAL_ACTION = TURN_INTENT_SCHEMA.properties.actions.items;
const OPERATION_TAGS = CANONICAL_ACTION.properties.domain.enum.flatMap((domain) =>
  getIntentActionsForDomain(domain).map((action) => `${domain}.${action}`));
const SCHEDULE_COMPONENTS = {
  relative_offset: ['offsetMinutes'],
  relative_day_time: ['dayOffset', 'hour'],
  calendar_date_time: ['month', 'day', 'hour'],
  weekday_time: ['weekday', 'hour'],
  local_time: ['hour'],
};
const SCHEDULE_VARIANTS = Object.entries(SCHEDULE_COMPONENTS).flatMap(([kind, fields]) =>
  fields.includes('hour')
    ? CANONICAL_ACTION.properties.schedule.properties.clockMode.enum.map((clockMode) => ({
      tag: `${kind}.${clockMode}`, kind, fields, clockMode,
    }))
    : [{ tag: kind, kind, fields }]);

function strictProviderSchema(schema) {
  const node = structuredClone(schema);
  // The canonical validator still enforces uniqueness; Groq rejects this keyword.
  delete node.uniqueItems;
  if (node.items) node.items = strictProviderSchema(node.items);
  if (node.anyOf) node.anyOf = node.anyOf.map(strictProviderSchema);
  if (node.properties) {
    const required = new Set(node.required || []);
    node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => {
      const converted = strictProviderSchema(value);
      // Keep scalar enums/ranges on a non-null branch, not on a nullable enum
      // which Groq can mistake for a second object discriminator.
      return [key, required.has(key) ? converted : { anyOf: [converted, { type: 'null' }] }];
    }));
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  return node;
}

function reminderCreateSchedule(canonical) {
  return { anyOf: SCHEDULE_VARIANTS.map(({ tag, kind, fields, clockMode }) => {
    const branch = structuredClone(canonical);
    branch.properties = {
      [TAG]: { type: 'string', enum: [tag], description: 'Wire tag. Must exactly match kind, and clockMode when this tag includes it.' },
      ...branch.properties,
    };
    branch.properties.kind = { type: 'string', description: `Must be ${kind}, matching _variant.` };
    branch.required = [TAG, 'kind', ...fields];
    if (clockMode) {
      branch.properties.clockMode = { type: 'string', description: `Must be ${clockMode}, matching _variant. explicit_am/explicit_pm/ambiguous_12h use hour 1..12; explicit_24h uses hour 0..23.` };
      branch.properties.hour = { ...branch.properties.hour, minimum: clockMode === 'explicit_24h' ? 0 : 1, maximum: clockMode === 'explicit_24h' ? 23 : 12 };
      branch.required.push('clockMode');
      // The only other required enum, weekday, is validated canonically. Avoid
      // a second discriminator while retaining its exact set in the description.
      if (fields.includes('weekday')) branch.properties.weekday = { type: 'string', description: `One of: ${canonical.properties.weekday.enum.join(', ')}.` };
    }
    return branch;
  }) };
}

export function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  const action = schema.properties.actions.items;
  if (attachmentOnly) {
    action.properties.domain.enum = ['conversation'];
    return strictProviderSchema(schema);
  }
  const allowed = OPERATION_TAGS.filter((tag) => isAdmin || tag !== 'admin.metrics');
  action.properties = {
    [TAG]: { type: 'string', enum: allowed, description: 'Wire tag: exact domain.action. Keep domain and action consistent with this tag; never invent fields to select a branch.' },
    ...action.properties,
  };
  action.properties.domain = { type: 'string', description: 'Canonical domain: must exactly match the domain in _variant.' };
  action.properties.action = { type: 'string', description: 'Canonical action: must exactly match the action in _variant.' };
  action.required = [TAG, ...action.required];
  const create = structuredClone(action);
  create.properties[TAG].enum = ['reminder.create'];
  create.required.push('content', 'schedule');
  create.properties.schedule = reminderCreateSchedule(CANONICAL_ACTION.properties.schedule);
  const other = structuredClone(action);
  other.properties[TAG].enum = allowed.filter((tag) => tag !== 'reminder.create');
  schema.properties.actions.items = { anyOf: [create, other] };
  return strictProviderSchema(schema);
}

export function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== null)
    .map(([key, child]) => [key, stripStructuredNulls(child)]));
}

export function normalizeProviderTurnIntent(value) {
  const normalized = structuredClone(value);
  for (const action of Array.isArray(normalized?.actions) ? normalized.actions : []) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
    if (Object.hasOwn(action, TAG)) {
      if (!OPERATION_TAGS.includes(action[TAG]) || action[TAG] !== `${action.domain}.${action.action}`) {
        throw new Error('El discriminador del proveedor no coincide con la acción canónica.');
      }
      delete action[TAG];
    }
    const schedule = action.schedule;
    if (schedule && typeof schedule === 'object' && Object.hasOwn(schedule, TAG)) {
      const variant = SCHEDULE_VARIANTS.find((item) => item.tag === schedule[TAG]);
      if (!variant || schedule.kind !== variant.kind || (variant.clockMode && schedule.clockMode !== variant.clockMode)) {
        throw new Error('El discriminador temporal del proveedor no coincide con los campos canónicos.');
      }
      delete schedule[TAG];
    }
  }
  return stripStructuredNulls(normalized);
}
