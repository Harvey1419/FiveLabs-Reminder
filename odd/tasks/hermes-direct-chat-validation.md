# Hermes direct chat validation

**Goal:** Validate recent Hermes core changes through the existing `npm run chat` CLI with one fresh synthetic identity, real router/tool effects, sequential user-like turns, and audited cleanup. Improve only reproducible product defects afterward.

**Branch:** `fix/hermes-chat-validation` from `main` (`a6c97f3`). The prior `fix/hermes-conversation-quality` branch is retained as a local backup but is not a source or delivery candidate. No push, merge, production deployment, payment or real-user mutation.

**Constraints:** Production Supabase is configured; no isolated test project. Use a generated non-routable dotted synthetic identity (not an E.164 phone that could receive traffic). Check exact normalized identity and both users/messages before insertion, do not touch preexisting identities. Disable the CLI scheduler. Limit OpenRouter requests to **120 total** for a target of ~30 turns (not a cost ceiling); stop at cap. Block unrelated outbound delivery/payment/calendar traffic. Child process gets stdin/stdout pipes; each turn waits for CLI prompt before next input. Report observations, not inferred tool success. Cleanup in `finally` is sequential, scoped and verified—not atomic; crashes may leave rows, which must be reported and not blindly retried. No ad-hoc Expect driver or shared inbound queue.

**Acceptance:** One bounded direct-chat run with real responses, observed database effects, response/tool truthfulness, preference-versus-quotation, task CRUD/reference continuity and safe provider degradation. Every run reports requested/completed turns, provider usage, failed/skipped checks, synthetic identity cleanup and any remaining rows. The run must not claim 30 turns if the cap stops earlier.

**Delivery:** Work-unit commits on feature branch; tests/docs with changes. Estimated scripted change may approach ~400 diff lines; retain reviewable slices and ask before multi-area expansion. RDD is off; focused checks and independent risk-gated verification apply.

## Tasks

- [x] DV-1 — Added opt-in `hermes-chat.UUID` identity preflight and scheduler-disable configuration to the existing CLI, plus preload enforcing allowed network destinations and 0–120 OpenRouter request cap. Legacy default remains. No meaningful live RED without production effects. `node --check` both files, `git diff --check` and offline fake-fetch guard check passed (2 allowed requests, third blocked; unknown origin/payment write blocked; allowed scoped reads/memory RPC). Live startup/DB isolation not yet verified. Route: bounded worker plus independent verifier. Commit: pending identity recording.
- [ ] DV-2 — Add `scripts/dev/run-chat-validation.js` using `spawn`/pipes, per-turn prompts and exact identity-scoped DB readback, report, and finally cleanup. Fix only runner defects during local dry checks; do not run against production until the planned budget and safety have been shown. Route: bounded worker and independent verifier. Commit: pending.
- [ ] DV-3 — After user-facing preflight of 120-request cap and cleanup risks, execute one direct production run, inspect answer claims against effects, then prioritize only corroborated core defects. No blind rerun. Commit: pending if any fixes are authorized and verified.

**Baseline:** The old branch's shared-queue run had 14/30 automatic passes but eight turns lacked local responses; it is not evidence of full conversation quality. Previous Expect controllers failed before real direct messages; one orphan synthetic identity was precisely cleaned and verified. No production run from this clean branch has started.

**Next:** Implement DV-1 without calling external services.
