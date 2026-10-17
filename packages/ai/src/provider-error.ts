import { aiResponseSchema, type AIResponse } from '@templelabs/contracts';
/** Safe vendor-neutral failure evidence. Incomplete accounting must never be presented as zero spend. */
export class AIProviderError extends Error {
  readonly usage: AIResponse['usage'];
  constructor(readonly code: string, usage: AIResponse['usage'] = { inputTokens: 0, outputTokens: 0 },
    readonly accountingComplete = true) {
    if (!/^[A-Z_]{1,80}$/.test(code)) throw new Error('Invalid provider failure code');
    super(code); this.name = 'AIProviderError';
    this.usage = Object.freeze(aiResponseSchema.shape.usage.parse(usage));
  }
}

/** The provider rejected the whole decision before returning executable calls.
 * Only the name is a hint: arguments must be generated again against a loaded schema.
 */
export class ToolSelectionError extends AIProviderError {
  constructor(readonly toolName: string, usage?: AIResponse['usage'], accountingComplete = false) {
    super('TOOL_SCHEMA_NOT_LOADED', usage, accountingComplete);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(toolName)) throw new Error('Invalid rejected tool name');
    this.name = 'ToolSelectionError';
  }
}

/** Whole inference rejected before any executable tool calls were returned. */
export class ToolArgumentsError extends AIProviderError {
  constructor(readonly toolName: string, usage?: AIResponse['usage'], accountingComplete = false) {
    super('TOOL_ARGUMENTS_REJECTED', usage, accountingComplete);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(toolName)) throw new Error('Invalid rejected tool name');
    this.name = 'ToolArgumentsError';
  }
}
