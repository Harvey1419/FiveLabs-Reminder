/** Validate the JSON Schema subset used by canonical action deltas. */
export function matchesSchema(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matchesType = types.some(type => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type);
  if (!matchesType || (schema.enum && !schema.enum.includes(value))) return false;
  if (value === null) return true;
  if (typeof value === 'number' && ((schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) return false;
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) return false;
  if (Array.isArray(value)) {
    if ((schema.minItems != null && value.length < schema.minItems) || (schema.maxItems != null && value.length > schema.maxItems)) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    return !schema.items || value.every(item => matchesSchema(item, schema.items));
  }
  if (typeof value === 'object') {
    if ((schema.required || []).some(key => value[key] === undefined)) return false;
    return Object.entries(value).every(([key, child]) => schema.properties?.[key]
      ? matchesSchema(child, schema.properties[key]) : schema.additionalProperties !== false);
  }
  return true;
}
