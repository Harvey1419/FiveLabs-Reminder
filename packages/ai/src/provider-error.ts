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
