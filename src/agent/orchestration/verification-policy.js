const SENSITIVE_KINDS = new Set([
  'execute_pending',
  'discard_pending',
  'revise_pending',
  'entity_delete',
  'entity_merge',
  'entity_deduplicate',
  'calendar_delete',
  'calendar_disconnect',
  'subscription_cancel',
]);

/**
 * Conversation is owned by the primary agent. A second model must never
 * reinterpret or rewrite ordinary prose/recall after Hermes has already seen
 * retrieved memory and conversation context.
 */
export function shouldVerifyProseDecision({ hasPendingState = false } = {}) {
  return Boolean(hasPendingState);
}

/**
 * Semantic verification is a risk control, not a second planner.
 * Ordinary reads and normal single-item mutations rely on the typed contract,
 * deterministic compiler and domain validation. Independent verification is
 * reserved for destructive/bulk/pending transitions where a false positive can
 * materially change user data.
 */
export function shouldVerifyManifest(manifest) {
  const operations = Array.isArray(manifest?.operations) ? manifest.operations : [];
  return operations.some((operation) => {
    if (!operation?.kind) return false;
    if (SENSITIVE_KINDS.has(operation.kind)) return true;
    if (operation.scope === 'all' || operation.scope === 'elapsed') return true;
    return false;
  });
}

/**
 * Cards already contain backend-owned truth. A second LLM is useful only when
 * the turn contains an excluded mixed clause that needs a short explanation.
 */
export function shouldSynthesizeResponseFrame({ excludedClauses = [] } = {}) {
  return Array.isArray(excludedClauses) && excludedClauses.length > 0;
}

export const VERIFICATION_POLICY = Object.freeze({
  sensitiveKinds: Object.freeze([...SENSITIVE_KINDS]),
});
