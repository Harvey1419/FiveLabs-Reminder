import { createRequire } from 'node:module';
import type { Tiktoken } from 'tiktoken/lite';

const require = createRequire(import.meta.url);
let tokenizer: Tiktoken | undefined;
/** Portable BPE estimate with 20% and framing reserve. Provider usage remains authoritative;
 * this estimate is not an exact tokenizer for every configured model. Load only for bounded turns. */
export function estimateBoundedInput(value: unknown): number {
  if (!tokenizer) {
    const { Tiktoken } = require('tiktoken/lite') as typeof import('tiktoken/lite');
    const ranks = require('tiktoken/encoders/o200k_base.json') as {
      bpe_ranks: string; special_tokens: Record<string, number>; pat_str: string;
    };
    tokenizer = new Tiktoken(ranks.bpe_ranks, ranks.special_tokens, ranks.pat_str);
  }
  return Math.ceil(tokenizer.encode(JSON.stringify(value), [], []).length * 1.2) + 256;
}
