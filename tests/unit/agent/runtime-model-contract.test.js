import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mandatory runtime model contract', () => {
  it('requires strict TurnIntent JSON on the initial Hermes decision and has no semantic recovery round', () => {
    const source = readFileSync(new URL('../../../src/agent/orchestration/router-core.js', import.meta.url), 'utf8');

    expect(source).toContain("type: 'json_schema'");
    expect(source).toContain('strict: true');
    expect(source).toContain("toolChoice: 'none'");
    expect(source).not.toContain('structured_recovery');
    expect(source).not.toContain('buildRecoveryMessages');
    expect(source).toContain('limit: 3');
    expect(source).toContain('MAX_HISTORY_CHARS');
  });
});
