import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@templelabs/contracts';
import { createObservedTargetResolver, type ObservedTargetOptions } from '../../../src/agent/orchestration/observed-target-resolution.js';
function fixture() {
  const complete = vi.fn(async () => ({ content: '{"position":1}' }));
  const getComplete = vi.fn(() => complete), resolve = createObservedTargetResolver(getComplete);
  const params: JsonObject = { action: 'complete',target: 'Review',content: 'Keep this',schedule: { hour: 16 } };
  const result: JsonObject = { success: false,errorCode: 'AMBIGUOUS_TARGET',data: { tasks: [{ id: 'one',title: 'Review first' },{ id: 'two',title: 'Review second' }] } };
  const options: ObservedTargetOptions = { toolName: 'manage_task',params,result,userText: 'Complete the first review',language: 'en',timezone: 'America/Bogota' };
  return { complete,getComplete,resolve,params,result,options };
}
describe('typed observation-bound orchestration', () => {
  it('binds only an observed identity and keeps all other authorized fields', async () => {
    const f = fixture(); expect(await f.resolve(f.options)).toEqual({ ...f.params,target: 'one' });
    expect(f.complete).toHaveBeenCalledOnce(); expect(f.params.target).toBe('Review');
  });
  it('snapshots the observation and operation across an asynchronous model call', async () => {
    const f = fixture(); let accept: (answer: { content: string }) => void = () => {};
    f.complete.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    const pending = f.resolve(f.options); f.params.action = 'delete'; f.params.content = 'Changed'; f.result.data = { tasks: [{ id: 'foreign' }] };
    accept({ content: '{"position":1}' }); expect(await pending).toMatchObject({ action: 'complete',content: 'Keep this',target: 'one' });
  });
  it.each([null,3,{},[{ id: 1 },{ id: 2 }],[{ id: 'one' },null],Array.from({ length: 13 },(_,i) => ({ id: String(i) }))])('does not plan from invalid candidates %j', async candidates => {
    const f = fixture(); f.result.data = { tasks: candidates }; expect(await f.resolve(f.options)).toBeNull(); expect(f.getComplete).not.toHaveBeenCalled();
  });
  it.each(['null','[]','{"position":1.5}','{"position":-1}','{"position":1,"target":"foreign"}'])('rejects a completion that cannot authorize a position: %s', async content => {
    const f = fixture(); f.complete.mockResolvedValueOnce({ content }); expect(await f.resolve(f.options)).toBeNull();
  });
  it('keeps an explicit injected provider independent of the legacy gateway', async () => {
    const f = fixture(), injected = vi.fn(async () => ({ content: '{"position":2}' }));
    expect(await f.resolve({ ...f.options,complete: injected })).toMatchObject({ target: 'two' }); expect(f.getComplete).not.toHaveBeenCalled();
  });
});
