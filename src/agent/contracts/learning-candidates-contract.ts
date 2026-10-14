export interface LearningCandidate { topicKey: string; category: 'fact' | 'decision' | 'preference' | 'episode';
  content: string; evidence: string; entityName?: string | null; entityCategory?: 'person' | 'company' | 'project' | 'place' | 'pet' | 'asset' | 'other' | null }
interface CandidateField { type: string; minLength?: number; maxLength?: number; enum?: readonly string[] }
export const LEARNING_CANDIDATES_SCHEMA = Object.freeze({
  type: 'array', maxItems: 16,
  description: 'CURRENT trusted user text ONLY; propose all useful durable facts, normally 0–3, [] if none. Assistant/history/attachments are not evidence. Exact contiguous quotes necessary, not sufficient; check full-turn quotation, denial, correction, attribution. Exclude tasks, appointments, transient actions, debts/balances, greetings/temporary states; retain independent mixed-turn facts even with memory.save. Atomic compact Spanish sentence per fact/preference/decision/episode. Lasting language/style qualifies, not utterance language/one-time requests; denial implies no opposite. Changed fact: reuse supplied topicKey; unchanged: omit. New keys: stable, value-independent; profile/<aspect> for self identity/residence/work, preference/<aspect> for lasting preferences, else <entity_type>/<slug>/<aspect>. Optional clean canonical entity hints; pet topics never authorize physical writes. Node independently admits before persistence.',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      topicKey: { type: 'string', minLength: 1, maxLength: 100 },
      category: { type: 'string', enum: ['fact', 'decision', 'preference', 'episode'] },
      content: { type: 'string', minLength: 1, maxLength: 180 },
      evidence: { type: 'string', minLength: 1, maxLength: 180 },
      entityName: { type: 'string', minLength: 1, maxLength: 80 },
      entityCategory: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'] },
    },
    required: ['topicKey', 'category', 'content', 'evidence'],
  },
});

export function validLearningCandidates(candidates: unknown): candidates is LearningCandidate[] {
  const { properties,required } = LEARNING_CANDIDATES_SCHEMA.items;
  const fields: Readonly<Record<string,CandidateField>> = properties;
  return Array.isArray(candidates) && candidates.length <= LEARNING_CANDIDATES_SCHEMA.maxItems
    && candidates.every((item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => Object.hasOwn(properties,key))
      && required.every(key => Object.hasOwn(item,key))
      && Object.entries(item).every(([key,value]: [string,unknown]) => {
        const field = fields[key];
        if (!field) return false;
        if (value === null && !required.includes(key)) return true;
        return typeof value === 'string' && value.trim().length > 0
          && (!field.maxLength || value.length <= field.maxLength)
          && (!field.enum || field.enum.includes(value));
      }));
}
