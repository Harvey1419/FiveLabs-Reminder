import type { JsonObject } from '@templelabs/contracts';

/** Model hints are separate from the original domain validator. Preserve types,
 * required fields, enums, nullability and numeric bounds; omit generated regexes
 * and string-length annotations. The registry still validates the full input.
 */
export function nativeToolSchema(value: JsonObject): JsonObject {
  const visit = (node: JsonObject[string]): JsonObject[string] => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => !['$schema', 'pattern', 'minLength', 'maxLength'].includes(key))
      .map(([key, child]) => [key, ['properties', '$defs', 'definitions', 'patternProperties'].includes(key)
        && child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, visit(schema)]))
        : ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else'].includes(key) ? visit(child) : child]));
  };
  return visit(value) as JsonObject;
}
