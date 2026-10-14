import { expect, vi, type Mock } from 'vitest';

/** The returned value is intentionally untrusted in malformed-provider tests. */
export function untrustedResultMock<F extends (...args: never[]) => unknown>(fn: F): Mock<(...args: Parameters<F>) => unknown> {
  return vi.mocked(fn) as unknown as Mock<(...args: Parameters<F>) => unknown>;
}

/** Fail with a useful assertion before inspecting a discriminated result. */
export function expectValid<T extends { valid: boolean }>(value: T): asserts value is Extract<T, { valid: true }> {
  expect(value.valid).toBe(true);
}
export function expectInvalid<T extends { valid: boolean }>(value: T): asserts value is Extract<T, { valid: false }> {
  expect(value.valid).toBe(false);
}
