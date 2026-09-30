/**
 * Historical dialogue is quoted data, not assistant output to imitate and not
 * a new user command. Preserve words and speakers for reference resolution;
 * do not inspect prose, redact numbers, or manufacture factual provenance.
 */
export function historyContextForModel(turns = []) {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  return [{
    role: 'user',
    content: JSON.stringify({
      kind: 'historical_dialogue',
      authority: 'reference_only',
      turns: turns.map((turn) => ({ speaker: turn.role, text: turn.content })),
    }),
  }];
}
