# Hermes premium device demo

## Objective and authorization
Re-present the existing 15-second Hermes conversation as a premium smartphone product video. User approved the supplied visual brief and recommended clean-screen derivative: remove only internal camera zoom/reframe tweens, preserving messages, design and timing.

## Scope and outcome
- Separate HyperFrames project: media/hermes-premium-device-demo/.
- Source screen is actual encoded MP4, not a rebuilt HTML conversation in the wrapper.
- Thin dark-metal phone, rounded glass, restrained glow/reflections/shadow/parallax, six approved motion windows and understated closing branding.
- Primary export: 1080×1350, exactly 15 seconds, 24fps, 360 frames, silent H.264, square pixels.
- Source 4:5 UI is contained, not stretched or cropped. Future 1080×1920 adaptation documented in project README.md:43; second export not required.
- Original project, original public MP4, landing and tests preserved. New public premium MP4/poster are separate and not integrated into landing.

## Constraints and budget
TDD off; fresh RDD off (clone_local and global). Local existing tooling only. No remote requests, new art/audio, paid/provider work, checkout/backend changes, system installs, commits, pushes or deployment.
Branch: feat/hermes-landing-demo; base a6c97f3.
Budget: maximum 4 child launches and 2 corrections for the same defect. Used 2 launches, no product corrections: writer muvvflac-b-tebw, verifier muvw5swy-c-re49. One temporary verifier-helper metadata bug was corrected without changing the candidate.
No commits: explicit user authorization is still required.

## Tasks
- [x] P1 — Build clean source derivative and premium phone composition; render primary export/poster. Done.
- [x] P2 — Verify preservation, encoded playback/geometry and deliver preview. Done.

## Artifact identities
- Premium public/hermes-demo-premium.mp4: 7,066,310 bytes; SHA256 11b393f7e191b171b14f8ab3e1b1769a96e713ee49ab7d0f87d60594ea56113d.
- public/hermes-demo-premium-poster.png: 393,209 bytes; SHA256 35cd76c83324d98a2b449cabc30f2720ad143f52c763713f4450a0f2f175f4c0.
- assets/clean-screen.mp4: 720×900, 15s, 24fps, 360 frames, silent; 906,916 bytes; SHA256 3b56cd43dcaff7f6b8cd23840188cb2d7b5b3b0cb2c48eefe426289ed7d49174.
- Original public/hermes-demo.mp4 remains 1,399,558 bytes, SHA256 d069bf67184e378c0f3c5cd3fe2b997a636876cdb06feb33c54751391bd41b2b.
- Preview copied without overwriting other files to /Users/lamparin/Downloads/hermes-demo-premium-preview.mp4; same premium bytes/hash. OS open command returned 0.

## Writer evidence
In media/hermes-premium-device-demo:
- npm run clean:prepare / clean:proof / clean:check / clean:render / clean:probe passed.
- npm run check / render / probe / poster / frames / preserve:after passed.
- Clean render 11.9s, premium render 19.9s. Premium check had no errors/warnings; clean check inherited logo warning and two transient Calendar-entry infos.
- Only six camera tween lines removed; eight messages and all remaining markup/design/arrival/timing/scroll/tap bytes preserved.
- Proof: proof/camera-only.diff, original-vs-clean.png, premium-phone-contact.png, frames/ and artifact-verification.json.
- Original 70 source/media/landing/test files checksum-identical. Parent spot-checked encoded contact sheet and hashes. git diff --check passed.
- Final 0.7 seconds holds device/materials/branding while the original screen ending continues, preserving its timing.

## Independent P2 — PASS on unchanged candidate
Executed:
cd media/hermes-premium-device-demo && npm run clean:probe
cd media/hermes-premium-device-demo && npm run probe
node /tmp/hermes-p2-P3PhmM/verify.mjs

- Both probes matched resolution, exact 15s/24fps/360 frames, single H.264 video, no audio, SAR 1:1.
- Existing scoped FFmpeg fully decoded all 360 frames in both videos with -xerror; no decoding errors.
- Independently confirmed eight messages, ordering and unchanged design/timing/scroll/tap bytes, with only six camera lines differing.
- 70 old baseline hashes and 274 current scoped repository files unchanged during verification.
- Twelve decoded source/output comparisons cover opening, briefing, notification/tap/departure, reminder, Calendar and closing, including 14.2083s. Same-time RMSE 1.45–11.54; settled 1.45–3.40; deliberately wrong-time 18.52–44.62. Raw and one-pixel-tolerant results retained. Sample correspondence is not exhaustive OCR or all-frame timing certification.
- Reused exact Express.static middleware (src/app/server.js:29), without backend startup: HTTP 200 video/mp4 full hash and 206 exact byte-range bytes passed.
- Cached Chromium: 31 progressing playback samples, actual loop, six nonmonotonic seeks, no media/page/failed-request errors.
- Independent analytical all-360 pose corners fit x96.52–968.64/y107.94–1206.70. Scale 0.92–1.06 (entrance exception), rotation ≤2°, translations ≤70px. Decoded native/272px frames corroborate full-phone visibility, containment and crisp native-resolution text.
- Source paused registered timeline and pose ladder are seek-safe structurally; exact branding and settled device/material/brand by 14.3s confirmed by source plus sampled closing frames.
- Browser/server closed, temporary browser profile removed; evidence retained at /tmp/hermes-p2-P3PhmM/result.json, geometry.json, helper/logs, *-all360.framemd5, frame-*-1080.png, frame-*-272.png and seek-*-272.png.
- Parent spot-check of result.json corroborated progressing playback, loop, six successful seeks, no errors and cleanup. No reproducible acceptance blocker.

## Skipped checks, incidents and limits
- P2 skipped clean:proof and preserve:after: they rewrite checked proof despite verification naming (scripts/prepare-clean.mjs:30–31; preserve.mjs:27). Parent approved temp-only independent substitutes; no repo/proof/export edits.
- First temp helper failed on pose metadata normalization, then passed after a temp-only correction. No source/export correction.
- No independent GSAP DOM sweep: no confirmed local cache after bounded lookup; no remote fetch authorized. Analytical source bounds + encoded frames are not runtime DOM proof. No independent all-frame rendered closing-hold sweep.
- At 272px overall width chat is about 11–12px, small but discernible; closing tagline/credit very small. Honest tradeoff versus the larger direct-chat version.
- No physical-device/Safari, backend, checkout or full-landing verification. Older landing T4 remains partial: native pause issue, prior 14.2s capture ambiguity and unreached reduced-motion/no-JS/media-error checks are not waived or claimed fixed.
- Native declared-inventory CLI assessment succeeded (medium; 349 paths/3950 lines including old uncommitted work); generated browser runtime excluded. Required inputs established safely without staging/deleting/ignoring to evade assessment.
- Facade ASSESS remained unavailable: explicit untracked declaration required, while supported inspect selection returned not-required under RDD off. Incident recorded; no further retry or authority created. Returned plan retained writer self-verification + independent verifier; P2 verified actual new artifact acceptance rather than recertifying the whole product.
- Native assessment continuation, relayed unchanged but not executed (RDD off):
  gentle-ai review status --cwd=/Users/lamparin/Documents/workspace_freelance/five-labs-co --contract=gentle-ai.review-integration/v2 --next-transition=true
- Optional native review not run while RDD off; no review approval or delivery authority implied.

## Next step
User reviews the opened Downloads preview. Landing still uses the original demo; integration and its pending full verification are separate follow-on work. No automatic new writer/verifier, commit or publication.
