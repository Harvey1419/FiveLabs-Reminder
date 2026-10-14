export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict RFC 4122 UUID validator. */
export function isStrictUUID(val: unknown): val is string {
  if (!val || typeof val !== 'string') return false;
  return UUID_REGEX.test(val.trim());
}

