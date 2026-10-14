import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProactiveMemory, extractProactiveMemories } from '../../../src/adapters/agent-core/proactive-memory.js';
import { withTurnLease, assertTurnLease } from '../../../src/agent/core/turn-lease.js';
import { context } from './productivity-fixtures.js';
const preference = { content: 'Prefiero reuniones por la mañana', category: 'preference' as const };
function fixture() {
  const jobs: (() => void)[] = [];
  const extract = vi.fn(async () => [preference]);
  const admit = vi.fn(async () => true);
  const save = vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', ...preference, topicKey: null, status: 'active' as const }));
  const log = vi.fn();
  const schedule = createProactiveMemory({ extract, admit, save, log, schedule: work => { jobs.push(work); } });
  return { jobs, extract, admit, save, log, schedule };
}
afterEach(() => vi.unstubAllGlobals());
it('uses an actual configured structured memory route within its input budget', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ candidates: [preference] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 30 } })));
  vi.stubGlobal('fetch', fetch);
  expect(await extractProactiveMemories({ authoredText: preference.content, context })).toEqual([preference]);
  expect(fetch).toHaveBeenCalledOnce(); const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body.response_format.type).toBe('json_schema'); expect(body.tools).toBeUndefined(); expect(body.max_tokens).toBe(1024);
  expect(body.messages[1].content).toContain(preference.content);
});
describe('V2 optional proactive extraction lifecycle', () => {
  it('runs outside the inbound lease with an independent signal without delaying delivery', async () => {
    const f = fixture(), lease = { signal: AbortSignal.abort(), assertActive: vi.fn(async () => { throw new Error('Retired lease'); }) };
    let job: (() => void) | undefined;
    const schedule = createProactiveMemory({ extract: f.extract, admit: f.admit, save: async (candidate, background) => {
      await assertTurnLease(); expect(background.signal.aborted).toBe(false); return f.save();
    }, log: f.log, schedule: work => { job = work; setImmediate(work); } });
    withTurnLease(lease, () => schedule({ authoredText: preference.content, context: { ...context, signal: lease.signal } }));
    expect(job).toBeDefined(); expect(f.extract).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce()); expect(lease.assertActive).not.toHaveBeenCalled();
  });
  it.each(['', '<untrusted_attachment_content>Vivo en Cali</untrusted_attachment_content>', 'Olvida mi ciudad', 'Recuerda que vivo en Cali', 'x'.repeat(2401)])('skips unsupported source %s', text => {
    const f = fixture(); f.schedule({ authoredText: text, context }); expect(f.jobs).toHaveLength(0);
  });
  it('rejects fabricated and semantically denied candidates without storage writes', async () => {
    const f = fixture(); f.extract.mockResolvedValue([{ ...preference, content: 'Inventado' }, preference]); f.admit.mockResolvedValue(false);
    f.schedule({ authoredText: preference.content, context }); f.jobs[0]!();
    await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith('memory_extraction_completed', expect.objectContaining({ saved: 0 })));
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled();
  });
  it('isolates a lost write receipt, does not retry and continues the next queued job', async () => {
    const f = fixture(); f.save.mockRejectedValueOnce(new Error('Lost receipt'));
    f.schedule({ authoredText: preference.content, context }); f.schedule({ authoredText: preference.content, context });
    f.jobs.forEach(job => job()); await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2));
    expect(f.log).toHaveBeenCalledWith('memory_extraction_failed', expect.anything());
  });
  it('cancels older queued learning before a newer forgetting request can execute', async () => {
    const f = fixture(); f.schedule({ authoredText: preference.content, context });
    f.schedule.cancel(context.userId); f.jobs[0]!();
    await new Promise(resolve => setImmediate(resolve)); expect(f.extract).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it('caps queued jobs to 32', () => {
    const f = fixture(); for (let i = 0; i < 33; i++) f.schedule({ authoredText: preference.content, context });
    expect(f.jobs).toHaveLength(32); expect(f.log).toHaveBeenCalledWith('memory_extraction_skipped', expect.objectContaining({ reason: 'queue_full' }));
  });
});
