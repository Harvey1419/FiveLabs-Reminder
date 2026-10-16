import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('public offline budget evaluators use the active decision policy', () => {
  it.each(['v2-context-budget-comparison', 'v2-complex-budget'])('checks %s without inference or relaxed limits', script => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', `scripts/evals/${script}.ts`], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_SECONDARY_MODEL: '', OPENROUTER_LAST_RESORT_MODEL: '' },
    });
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report.mode).toMatch(/^offline_/);
    expect(report.productionPolicy).toMatchObject({ structuredDecisions: true, maxInputTokens: 2500,
      maxOutputTokens: 2048, maxTotalTokens: 20000, maxModelSteps: 10, maxToolCalls: 10, continuationReserveTokens: 256 });
    expect(report.results.some((row: { decisionControlAdvertised: boolean }) => row.decisionControlAdvertised)).toBe(true);
    for (const row of report.results) {
      expect(row.maxInputEstimate).toBeLessThanOrEqual(row.budget);
      expect(row.writes).toBeLessThanOrEqual(row.expectedWrites ?? (row.case.includes('cancel') ? 1 : 0));
    }
    if (script === 'v2-context-budget-comparison') {
      expect(child.stderr).toBe('');
      expect(report.results.find((row: { case: string; budget: number }) => row.case === 'greeting' && row.budget === 2500)).toMatchObject({ complete: true, writes: 0 });
    } else {
      expect(report.externalEffects).toEqual({ productionWrites: 0, WhatsAppSends: 0, inference: 'none' });
      const records = child.stderr.trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(report.results.length);
      for (const name of ['typed_three_reminders', 'typed_reminders_and_tasks', 'typed_relative_and_clock']) {
        const row = report.results.find((row: { case: string; budget: number }) => row.case === name && row.budget === 2500);
        expect(row).toMatchObject({ complete: true, decisionControlAdvertised: true });
        expect(row.decisions.some((step: { calls: { name: string }[] }) => step.calls.some(call => call.name === 'conversation_decide'))).toBe(true);
      }
      expect(report.results.find((row: { case: string; budget: number }) => row.case === 'bounded_steps_negative_control' && row.budget === 2500)).toMatchObject({ complete: false, writes: 0 });
    }
  }, 50000);
});
