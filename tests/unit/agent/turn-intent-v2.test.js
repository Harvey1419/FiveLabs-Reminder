import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileTurnIntentV2, isTurnIntentV2 } from '../../../src/agent/orchestration/turn-intent-v2.js';
import { getAgentToolDefinitions, validateToolCall } from '../../../src/agent/contracts/tool-contracts.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TurnIntent v2', () => {
  it('compiles a simple reminder without making the model author protocol fields', () => {
    const intent = {
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Comprar leche',
        schedule: {
          kind: 'relative_day_time',
          dayOffset: 1,
          hour: 8,
          minute: 0,
          clockMode: 'ambiguous_12h',
        },
      }],
    };

    const result = compileTurnIntentV2(intent, {
      userMessage: 'Recuérdame comprar leche mañana a las 8',
    });

    expect(result.valid).toBe(true);
    expect(result.manifest.operations).toEqual([expect.objectContaining({
      sequence: 1,
      kind: 'reminder_create',
      sourceQuote: 'Recuérdame comprar leche mañana a las 8',
      content: 'Comprar leche',
    })]);
    expect(intent.actions[0]).not.toHaveProperty('sequence');
    expect(intent.actions[0]).not.toHaveProperty('sourceQuote');
    expect(intent.actions[0]).not.toHaveProperty('contextRef');
  });

  it('maps human targets directly and leaves ID resolution to Node', () => {
    const result = compileTurnIntentV2({
      actions: [{ domain: 'task', action: 'complete', target: 'la segunda' }],
    }, { userMessage: 'La segunda ya la hice' });

    expect(result).toMatchObject({
      valid: true,
      manifest: {
        operations: [{
          sequence: 1,
          kind: 'task_complete',
          sourceQuote: 'La segunda ya la hice',
          targetName: 'la segunda',
        }],
        excludedClauses: [],
      },
    });
  });

  it('creates pending-state protocol internally instead of exposing it to the model', () => {
    const result = compileTurnIntentV2({
      actions: [{ domain: 'pending', action: 'execute', target: '1' }],
    }, { userMessage: 'Sí, hazlo' });

    expect(result.valid).toBe(true);
    expect(result.manifest.operations[0]).toMatchObject({
      kind: 'execute_pending',
      contextRef: { source: 'pending_state', position: 1 },
    });
  });

  it('keeps multi-action order while generating sequence numbers internally', () => {
    const result = compileTurnIntentV2({
      actions: [
        { domain: 'task', action: 'create', title: 'Comprar pan' },
        { domain: 'reminder', action: 'create', content: 'Llamar a mamá', schedule: { kind: 'relative_offset', offsetMinutes: 30 } },
      ],
    }, { userMessage: 'Anota comprar pan y recuérdame llamar a mamá en 30 minutos' });

    expect(result.valid).toBe(true);
    expect(result.manifest.operations.map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([
      { sequence: 1, kind: 'task_create' },
      { sequence: 2, kind: 'reminder_create' },
    ]);
  });

  it('preserves excluded clauses for mixed in-scope/out-of-scope turns', () => {
    const result = compileTurnIntentV2({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Caminar',
        schedule: { kind: 'relative_offset', offsetMinutes: 15 },
      }],
      excluded: [{ quote: 'explícame cómo depurar Node', reason: 'prohibited' }],
    }, { userMessage: 'Recuérdame caminar en 15 minutos y explícame cómo depurar Node' });

    expect(result.valid).toBe(true);
    expect(result.manifest.excludedClauses).toEqual([
      { sourceQuote: 'explícame cómo depurar Node', reason: 'prohibited' },
    ]);
  });

  it('rejects unsupported domain/action pairs deterministically', () => {
    const result = compileTurnIntentV2({
      actions: [{ domain: 'reminder', action: 'explode' }],
    }, { userMessage: 'haz algo' });

    expect(result).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_ACTION' });
  });

  it('detects v2 payloads without confusing legacy manifests', () => {
    expect(isTurnIntentV2({ actions: [] })).toBe(true);
    expect(isTurnIntentV2({ operations: [] })).toBe(false);
  });

  it('exposes v2 to the model by default and compiles it before the router sees it', () => {
    const [tool] = getAgentToolDefinitions();
    expect(tool.function.name).toBe('execute_turn');
    expect(tool.function.parameters.required).toContain('actions');
    expect(tool.function.parameters.properties).not.toHaveProperty('operations');

    const validated = validateToolCall({
      toolName: 'execute_turn',
      params: {
        sourceQuote: 'La segunda ya la hice',
        actions: [{ domain: 'task', action: 'complete', target: 'la segunda' }],
      },
    });

    expect(validated).toMatchObject({
      valid: true,
      params: {
        operations: [{ kind: 'task_complete', targetName: 'la segunda' }],
        excludedClauses: [],
      },
    });
  });

  it('can immediately roll back the model-facing contract with AGENT_PLANNER_V2=false', () => {
    vi.stubEnv('AGENT_PLANNER_V2', 'false');
    const [tool] = getAgentToolDefinitions();
    expect(tool.function.parameters.required).toContain('operations');
    expect(tool.function.parameters.properties).not.toHaveProperty('actions');
  });

  it('keeps admin unavailable to ordinary users at the model boundary', () => {
    const [normalTool] = getAgentToolDefinitions({ isAdmin: false });
    const normalDomains = normalTool.function.parameters.properties.actions.items.properties.domain.enum;
    expect(normalDomains).not.toContain('admin');

    const [adminTool] = getAgentToolDefinitions({ isAdmin: true });
    const adminDomains = adminTool.function.parameters.properties.actions.items.properties.domain.enum;
    expect(adminDomains).toContain('admin');
  });
});
