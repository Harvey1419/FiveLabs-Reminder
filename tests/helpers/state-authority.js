import assert from 'node:assert/strict';

/** Evidence assertions for tests only. This never interprets user language. */
export function assertTaskReadEvidence(result, { expectedIds, forbiddenAmounts = [] } = {}) {
  const facts = (result?.executionFacts || []).filter((fact) => (
    fact.tool === 'manage_task' && fact.success === true
      && (fact.requestedAction === 'list' || fact.action === 'listed_tasks')
  ));
  assert.ok(facts.length > 0, 'A live-state answer must carry a successful task read, not only chat text.');
  const records = facts.flatMap((fact) => {
    const data = fact.presentationData;
    return Array.isArray(data) ? data : (data?.tasks || []);
  });
  if (expectedIds) {
    assert.deepEqual([...new Set(records.map((item) => item.id))].sort(), [...expectedIds].sort(),
      'Read evidence must contain exactly the expected records.');
  }
  assertNoAmounts(result, forbiddenAmounts);
}

export function assertNoAmounts(result, amounts = []) {
  const text = String(result?.confirmation || '');
  for (const amount of amounts) {
    // Synthetic assertion: tolerate punctuation/spacing, not arbitrary app NLP.
    const digits = String(amount).replace(/\D/g, '');
    assert.ok(digits.length > 0, 'The forbidden amount must contain digits.');
    const pattern = new RegExp(`(?<![0-9])${digits.split('').join('[.,\\s\\u202f\\u00a0]*')}(?![0-9])`, 'u');
    assert.ok(!pattern.test(text), `Response reused forbidden historical amount ${digits}.`);
  }
}

export function assertReadFailureEvidence(result, forbiddenAmounts = []) {
  assert.ok((result?.executionFacts || []).some((fact) => (
    fact.tool === 'manage_task' && fact.success === false
  )), 'An unavailable task source must remain an explicit failed read.');
  assertNoAmounts(result, forbiddenAmounts);
}
