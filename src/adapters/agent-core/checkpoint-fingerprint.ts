import { createHash } from 'node:crypto';
import type { JsonObject } from '@templelabs/contracts';
function canonical(value: JsonObject[string]): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
export function checkpointFingerprint(value: JsonObject): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
