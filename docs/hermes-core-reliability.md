# Hermes core reliability and rollback

This change strengthens source-backed assistant responses and memory persistence while keeping ordinary conversation available. It introduces no database migration and does not change provider credentials or reasoning budgets.

## Review by behavior

| Area | Main implementation | Invariants |
|---|---|---|
| Memory writes | `src/features/memory/`, `src/agent/tools/memory.js`, `intent-executor.js` | Explicit and automatic extraction share one source-attributed path. Confirm only persisted facts; avoid duplicate raw writes. |
| Retrieval | `src/infrastructure/database/memories.js`, `personal-knowledge.js` | Verify owner, active version and validity before citation. Unavailable is not an empty memory. Display labels do not replace semantic categories. |
| Mixed assistance | `intent-contracts.js`, `router-core.js`, `observed-answer.js` | Personal sources can accompany live read cards and requested fields without adding a model phase. Sources do not grant mutation permissions. |
| Reference continuity | `working-memory-store.js`, `intent-executor.js` | Field-only answers do not renumber a visible list. Provider failures preserve reference age and context; invalid references do not create impossible pending drafts. |
| Profile and language | `turn-context.js`, `response-policy.js` | Current authorization controls persistence; old optional updates cannot block valid reads/conversation. Quotes are not language-change instructions. |
| Historical evidence | `observed-answer.js` | Successful operations and queries remain historical proof. Selecting historical sources does not perform a fresh read or certify arbitrary model prose. |

Behavior tests accompany these areas in `tests/unit/agent/` and `tests/unit/memory/`. Existing provider-wire fixtures use qualified operations and explicit response authority so negative tests reach the intended permission and execution checks.

## Validation performed

- Complete unit suite: **1,473 passing tests in 143 files** at local delivery closure.
- Source syntax checks and `git diff --check`: passed.
- Real synthetic validation exercised the configured model, core routing, domain tools and owner-scoped database records.
- Final targeted recovery exercised 13 messages: creation proof, nonexistent reference without effects, recovery by name, note removal without task deletion, current listings, preference recall and historical summary.
- Synthetic shutdown and cleanup were verified. No real customer records were cleaned or migrated.
- Provider error envelopes were intentionally omitted from private traces when they might contain headers. Evidence gaps were retained rather than represented as complete capture. These are not proof of complete end-to-end coverage.

Run the normal unit suite with `pnpm run test:unit`. Live validation is opt-in and requires separate credentials, request budgets and approval. The owned runner is `scripts/dev/run-chat-validation.js`; scenario fixtures live in `chat-validation-scenarios.js`. Do not run it merely to verify syntax: it creates synthetic database records and sends provider requests.

## Rollout gate

The code is a reviewed/tested release candidate, not an assertion of zero hallucinations. Before production rollout:

1. Require green CI on the exact PR head and review the memory, response and mutation changes together.
2. Smoke-test the deployed artifact in staging with the actual WhatsApp transport, Google integration and payment webhooks applicable to the installation.
3. Confirm environment parity and existing schema compatibility. Supported entity write categories match the committed schema; unsupported optional memory annotations do not prevent factual memory persistence.
4. Record the deployed commit/image and the prior production image. Do not conflate opening a PR with approving rollout.

Legacy invalid memories/drafts are not rewritten by this code change. Data repairs need their own scope and approval. Personal memories represent user statements, not independent verification of their real-world truth. Free conversational prose still relies on model interpretation; the deterministic guarantees apply to validated identities, permissions, source bindings and observed tool outcomes.

## One-PR rollback

A squash merge is recommended for this coordinated change so the complete PR becomes one revertable commit. The PR description records its base and head SHAs. Keep the PR URL and, after merging, the actual merge commit SHA.

For a squash merge, create a new branch from the then-current `main` and run:

```bash
git revert <actual-squash-merge-sha>
```

If GitHub used a normal two-parent merge instead, inspect its parents first, then use:

```bash
git revert -m 1 <actual-merge-sha>
```

Review and test the revert as a new PR, then redeploy the previous compatible artifact. Do not force-push `main`, reset shared history, or assume reverting Git rolls back database contents. Memories, messages and other data written after rollout remain; inspect them separately without deleting customer data automatically.

Pre-change branch point for this feature: `a6c97f37f2b7ac7357c9c3944b6ca0689bbf7c6a`. This is a reference point, not a substitute for inspecting the actual merge result and later changes.
