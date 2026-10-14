import { memoryResultSchema, type MemoryResult, type MemoryRecord, type TurnContext } from '@templelabs/contracts';
import type { MemoryDomainPort, ToolOutcome } from '@templelabs/tools';
import { supabase } from '../../infrastructure/database/index.js';
import { domainInput, type ProductivityUser } from '../../features/productivity-domain.js';
import { createNativeMemoryStore, MemoryStorageError, type NativeMemoryClient, type NativeMemoryStore } from '../../features/memory/native-store.js';
import { explicitMemoryIntent } from '../../features/memory/explicit-intent.js';
import { admitExplicitMemory, embedExplicitMemory, verifyMemoryForget } from './memory-admission.js';
export function createMemoryDomainPort(user: ProductivityUser, authoredText: string, dependencies: {
  store?: NativeMemoryStore; previousRecords?: readonly MemoryRecord[]; verifyForget?: typeof verifyMemoryForget; admit?: typeof admitExplicitMemory; embed?: typeof embedExplicitMemory;
} = {}): MemoryDomainPort {
  let observed = [...(dependencies.previousRecords ?? [])].slice(0, 5).map(record => record.status === 'forgotten' ? { ...record, content: '[forgotten memory]' } : record);
  const displayed = [...observed];
  const getStore = () => dependencies.store ?? createNativeMemoryStore(supabase as unknown as NativeMemoryClient);
  return { async execute(request, context, operationId): Promise<ToolOutcome<MemoryResult>> {
    await domainInput(user, context);
    if (request.operation !== 'read' && !explicitMemoryIntent(authoredText, request.operation)) return {
      status: 'denied', code: 'EXPLICIT_MEMORY_INTENT_REQUIRED', observation: 'No memory changed: an explicit authored request is required.' };
    if (request.operation === 'save') {
      const start = request.input.evidenceStart ?? authoredText.indexOf(request.input.content);
      const end = request.input.evidenceEnd ?? start + request.input.content.length;
      if (start < 0 || authoredText.slice(start, end) !== request.input.content) return {
        status: 'denied', code: 'MEMORY_EVIDENCE_MISMATCH', observation: 'The memory must exactly match a span in the authored current user text.' };
      try {
        if (!await (dependencies.admit ?? admitExplicitMemory)(authoredText, { ...request, input: { ...request.input, evidenceStart: start, evidenceEnd: end } }, context)) return {
          status: 'denied', code: 'MEMORY_NOT_ADMITTED', observation: 'No memory changed: durability and user attribution were not confirmed.' };
      } catch { return { status: 'failed', code: 'MEMORY_ADMISSION_UNAVAILABLE', observation: 'No storage write attempted; semantic admission was unavailable.' }; }
      await domainInput(user, context);
    }
    try {
      const store = getStore();
      let scopeDenied = false;
      const records = request.operation === 'read' ? await store.read(request.input.query, context)
        : request.operation === 'save' ? [await store.save(request.input.content, request.input.category, context, async () => {
          const vector = await (dependencies.embed ?? embedExplicitMemory)(request.input.content, context);
          await domainInput(user, context); return vector;
        })] : [await store.forget(request.input.memoryId, context, async record => {
          const candidates = observed.some(value => value.id === record.id) ? observed.map(value => value.id === record.id ? record : value) : [record];
          const verified = await (dependencies.verifyForget ?? verifyMemoryForget)(authoredText, candidates, record.id, context, displayed);
          scopeDenied = !verified; await domainInput(user, context); return verified;
        })].filter(value => value !== null);
      if (scopeDenied) return { status: 'clarification_required', code: 'MEMORY_SCOPE_REQUIRED', observation: 'No deletion attempted: the whole memory was not confirmed within the authored request.' };
      if (request.operation !== 'read' && !records.length) return { status: 'clarification_required', code: 'MEMORY_NOT_FOUND', observation: 'The memory is no longer active; read again before changing it.' };
      const data = memoryResultSchema.parse({ operation: request.operation, records, complete: true,
        coverage: request.operation === 'read' ? 'bounded_list' : 'operation', presentation: { canonicalCard: null, questions: [], cta: null } });
      await domainInput(user, context);
      observed = request.operation === 'forget' ? observed.map(record => record.id === request.input.memoryId ? { ...record, status: 'forgotten' as const, content: '[forgotten memory]' } : record) : records;
      return { status: 'success', data, receipt: { userId: context.userId, operationId, toolName: `memory_${request.operation}`, resourceIds: records.map(record => record.id) },
        observation: JSON.stringify({ operation: data.operation, complete: true, coverage: data.coverage, records: data.records.slice(0, 5).map(record => ({ ...record, content: record.content.slice(0, 80) })) }) };
    } catch (error) {
      if (request.operation !== 'read' && (!(error instanceof MemoryStorageError) || error.writeStarted)) return {
        status: 'indeterminate', operationId, observation: 'Memory write outcome unknown; reconcile before retrying.' };
      return { status: 'failed', code: 'MEMORY_STORAGE_UNAVAILABLE', observation: 'No memory change confirmed; the owned storage read failed.' };
    }
  } };
}
