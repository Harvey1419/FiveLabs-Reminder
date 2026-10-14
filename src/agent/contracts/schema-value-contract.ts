/** Deliberately the existing JSON Schema subset, not a general JSON Schema validator. */
export interface ActionSchemaSubset {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly minimum?: number; readonly maximum?: number; readonly minLength?: number;
  readonly minItems?: number; readonly maxItems?: number; readonly uniqueItems?: boolean;
  readonly items?: ActionSchemaSubset;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string,ActionSchemaSubset>>;
  readonly additionalProperties?: boolean;
}
export function matchesSchema(value: unknown,schema: ActionSchemaSubset): boolean {
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type ?? [];
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
    return !schema.items || value.every((item: unknown) => matchesSchema(item,schema.items!));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value),fields = new Map<string,unknown>(entries);
    if ((schema.required ?? []).some(key => fields.get(key) === undefined)) return false;
    return entries.every(([key,child]) => schema.properties?.[key]
      ? matchesSchema(child,schema.properties[key]) : schema.additionalProperties !== false);
  }
  return true;
}
