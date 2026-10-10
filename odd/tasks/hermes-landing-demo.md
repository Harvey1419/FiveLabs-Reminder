# Hermes landing and demo

## Objective and scope
Make the public landing concise/mobile-safe and demonstrate Hermes before checkout.
Preserve WhatsApp CTA https://wa.link/iekvou, privacy/terms and Google/OAuth disclosures.
Authorized current demo: 15s silent continuous WhatsApp-style conversation including Morning Briefing, Calendar context and a correctly timed reminder; large 4:5 presentation.

## Latest accepted creative refinement
- Replace H avatar with existing Hermes TempleLabs logo; use brand identity in header/notification.
- More faithful WhatsApp message bubbles, timestamps, checks, composer and typing; blacker background.
- Remove visible “Ejemplo ilustrativo” from video and matching static fallback. Source/docs still identify synthetic demonstration; no official-partnership or live-data claims.
- Guided zoom on composed text, transition to response, simulated WhatsApp notification, visible tap and zoom/open into delivered message.
- At least six short readable messages, continuous follow-scroll, no return to disconnected presentation cards or title-only day jumps.
- Preserve exact 15s, muted loop, controls, readable holds, reduced-motion/no-JS/error static fallback.
- Source/composition safe zones keep message text clear of native controls at 320px; modest camera zooms must not crop active text.

## Constraints
No checkout, backend/Stripe/activation/calendar integration, live messages, real personal data, paid/hosted generation, commits/push/deploy or system/global installation.
TDD off. RDD off (fresh clone_local/global reads). HyperFrames usage unknown unsupported_harness; local rendering only.
Branch feat/hermes-landing-demo; base a6c97f3. Existing scoped FFmpeg/FFprobe and cached HyperFrames/browser reused.
Revision budget exhausted:6/6child launches used. Stop automatic work; any additional agent/check requires explicit new bounded user authorization. No gate waived. Stop at exhaustion even if verification pending; no automatic renewal.
Maximum 2 corrections for same defect: prior wrapping1/2 and timing1/2 resolved. No unrelated polish expansion.
Generated .hyperframes/playback-profile browser runtime is not source/delivery; do not publish/stage it or delete unrelated human files.

## Acceptance
- No repeated general Hermes explanation; distinct sections and preserved legal/data-use links.
- No document horizontal overflow/clipping at 320/375/390/768/1440 widths.
- Final demo actual15s, portrait720x900 (or justified equivalent),24fps,no audio; source and public assets reproducible.
- Chat materially larger than original landscape, readable in natural playback, current brand/logo and latest requested transitions observable.
- Payment/checkout untouched; actual Calendar behavior not modified or falsely represented.

## Tasks
- [x] T1 — Clean up landing copy/responsive and initial local demo. Done; initial writer checks observed.
- [x] T2 — Verify initial landing. Done; initial Chromium acceptance observed, not proof for later exports.
- [x] T3 — Finish branded enlarged WhatsApp demo with writing/result zoom and notification-tap transition. Done; final writer source/encoded checks observed.
- [ ] T4 — Verify final revised media and mobile/desktop integration. Pending/blocked: final verifier6/6 returned partial, budget exhausted.

## Checks
Writer foreground commands:
node --check src/http/views/home.js
pnpm exec vitest run --config tests/config/vitest.unit.js tests/unit/home.test.js
cd media/hermes-landing-demo && npm run check
cd media/hermes-landing-demo && npm run render
cd media/hermes-landing-demo && npm run probe
cd media/hermes-landing-demo && npm run poster
Inspect encoded phone-scale frames and real-time sequence, not only composition snapshots/string assertions.
Final bounded browser runner reuses disposable Express renderer/static server and cached Chromium; five widths, native touch pause/resume,loop,motion/no-JS/error fallback, assets and current scene/control clearance. No full backend suite or paid tests.

## Observed continuity
- Initial landing: syntax,5renderer tests,HyperFrames check/render/probe and five-width Chromium overflow/playback/fallback/assets passed. Missing globalFFmpeg/FFprobe resolved using pinned local packages. No physical Safari/device or live backend certification.
- Earlier15s card design: encoded wrapping and09:00time consistency corrected. User rejected small/card-based appearance; old verifier stopped and closed browser/server, results obsolete for redesigned chat.
- Revision launch4/6: 720x900continuous8-message chat,typing,scroll,notification handoff,15s/24fps/360frames/no audio.5tests/syntax/check/render/probe/poster passed; official check0errors0warnings,71contrast checks,5motion assertions,5entrance infos. Isolated encoded playback/pause/control-safe frames passed; full-landing verification not yet performed.
- Current pre-branding MP4:918918bytes SHA2561f23ac086c13c3b4601e2fed95aa0615f24795351e4f4b2f714ae5a2df2f8fc2;poster160710bytes SHA2566b6cff1a02a6de5d34393d7ce4ddeda912ed0b7797b8fc094240140a5dc68f66.
- Parent syntax/diff checks and continuous-phone-contact.png inspection passed for that pre-branding candidate.
- Native facade ASSESS lacks intended-untracked declaration route; supported read-only native assess with provider inventory and explicit intended paths succeeded medium (82paths/2404lines).211generated browser-runtime paths excluded from intended delivery, not removed.
- Native continuation retained unchanged, not executed while RDD off: gentle-ai review status --cwd=/Users/lamparin/Documents/workspace_freelance/five-labs-co --contract=gentle-ai.review-integration/v2 --next-transition=true
- User preview copy exists at ~/Downloads/hermes-demo.mp4 and was opened. This is pre-branding version; do not confuse with future export.
- Work-unit commits and publication: none, awaiting explicit user authorization.

## Final branding evidence
- Writer launch5/6 delivered actual public/Logo.png brand copy, darker WhatsApp bubble/composer treatment, compose/send/result zooms and visible notification tap/release opening into09:00reminder; eight messages and15sportrait preserved, visible illustrative overlay removed.
- Five renderer tests/syntax/check/render/probe/poster and existing encoded real-time helper passed. Check60/60contrast and5motion assertions; initial banner overlap corrected once. Nonblocking duplicate-logo discovery warning and2transient Calendar-entry infos remain.
- Final MP41399558bytes SHA256d069bf67184e378c0f3c5cd3fe2b997a636876cdb06feb33c54751391bd41b2b;poster145145bytes SHA25642e2ae3ffab7f943bd6c7222f635fcd77b180bd19ce9c24d9dab15b04179d198.720x900/15s/24fps/360frames/no audio.
- Parent inspected branded-phone-contact.png and syntax/diff checks passed. Final declared-scope native assessment medium88paths2429lines;Rddoff,noauthority. Prior Downloads copy is obsolete; final branded copy not yet created.
- Browser/context/helper server closed; no background Studio. Full-landing final acceptance still pending, do not reuse historical PASS.

## Final verifier outcome — partial
- Exact runner node /tmp/hermes-landing-verify-final.mjs failed at:114:44 on later phone paused-clearance check:pausedfalse after2nativecontroltaps. No rerun/sourcefix;browser/server closed.
- All5widths no overflow,overflow-xvisible. VideoCSS272x340at320;480x600desktop. Assets200correctMIME/bytes/hashes. Native initialphone/desktoppause/resume,playbackadvance andnatural loops observed.
- Paintedcomposer0.79/send1.23,result2.59/4.23,brandedbanner8.76/tap9.03/open9.74/reminder10.34/Calendar13.21inspected;largerchat/logo/nooverlay andmaintextclearcontrols observed.
- Unresolved:phone14.20capturepartiallyclipped compared withcomplete13.20;artifactvsexportdefectunproven. Latertouchpausefailure may be automation,not establishedappdefect.
- Missing:initial/dynamicreducedmotion,noJS,mediaerror runtime checks not reached after failed assertion. HistoricalPASS cannot replace finalcandidatechecks. Chromium145simulatedtouch,fallbackfonts,notphysicalSafari/backendcertification.
- Evidence retained: /var/folders/gt/4q1sjf9d27zf5sdjhw2xggnh0000gn/T/hermes-landing-evidence-nEmwM0. HomeSHAbf52318221c2db1019d89f147db30e8ceac9335deeb804020954efd61231f0cf;MP4/posterhashesaboveunchanged.
- Preview copied without overwriting earlier version to ~/Downloads/hermes-demo-branding-preview.mp4 and opened. Preview is not verified completion or publication.

## Next step
STOP:budget6/6exhausted,T4pending. User can inspect brandedpreview. Proposed nextscope ONLY if explicitlyauthorized:one additional verifier run to resolve14.2sencoded-vs-captureambiguity,touchcontroltest andmissingfallbackchecks;no redesign. If actual defect needs sourcecorrection,report andrequest separate bounded scope. Checkout deferred,no commit/publish.
