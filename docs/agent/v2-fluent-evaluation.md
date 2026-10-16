# Evaluate one bounded, synthetic 20-turn conversation

`scripts/evals/v2-fluent-conversation.ts` prepares the live-provider acceptance gate for [T4/S4 and S2](../../odd/tasks/v2-mixed-clarification.md). It uses the real `ProductivityTurnRunner`, `DurableProductivityAssistant`, host presenter, and in-memory lease checkpoints, but **never production records, a database, WhatsApp, or application startup**. Offline tests prove the fixture and grading seams, not live model interpretation.

## Safe default

```bash
node --import tsx scripts/evals/v2-fluent-conversation.ts --help
node --import tsx scripts/evals/v2-fluent-conversation.ts
```

Both commands avoid credentials, inference, and report writes. The second prints the explicit conversation plan; it does not fabricate a successful run. Importing the module in a test does not invoke the CLI.

## Live command — operator/parent only

**Do not run this command as part of implementation or offline verification.** Obtain current prices and billing metadata independently first. The evaluator does not fetch prices.

```bash
node --import tsx scripts/evals/v2-fluent-conversation.ts --live --pricing odd/fluent-pricing.json --output odd/fluent-result.json
```

| Option | Contract |
| --- | --- |
| `--help` | Help only, with no credential loading or network. |
| `--live` | Explicitly enables one paid run. Disabled by default. |
| `--directed` | First 2 turns only; fixed 6 HTTP / US$0.02 limits, primary route only. Does not imply `--live`. |
| `--pricing <path>` | Existing in-project JSON containing `rates`; extra preflight metadata such as `models` is allowed. |
| `--output <path>` | New in-project `.json` file; its parent directory must already exist. Existing files and symlink escapes are rejected. |

`--directed` selects one fixed, smaller plan: the first **2 chained turns**, at most **6 HTTP inference requests** and **US$0.02 new spend**, using only the configured primary route (no route fallback). Use `--directed` alone for a safe dry plan, or add it to the live command after explicit operator authorization. It never relaunches the 20-turn gate or reconciles previous unknown spend. Reports retain `liveProof: false` for this mode; `directedProof` can establish only this smaller plan.

No arbitrary limit override, isolated-case selector, budget increase, automatic rerun, or script-level semantic retry exists. Unknown/duplicate options return exit 2 before credentials or network. Live mode requires both paths. Exit 0 means the dry/help command succeeded, or every live turn passed with no stop condition. Live failures return exit 1; inspect the report, not just the exit code.

Pricing format (numbers are **USD per token**, not per million tokens):

```json
{
  "rates": {
    "configured/model-alias": { "prompt": 0.0000001, "completion": 0.0000004 }
  }
}
```

The example numbers are illustrative, **not verified rates**. Supply real rates for every selected route (primary only with `--directed`; primary, secondary and last resort otherwise) and verify any extra request fees independently. The same rates are snapshotted for the entire run. No pricing endpoint is called by this script. Runner cost estimates use the maximum supplied route rates; authoritative HTTP-level accounting is the sibling budget transport, not that conservative estimate.

## Fixed safety envelope

- One conversation, **20 chained Spanish user messages**, at most **60 actual HTTP inference requests**, at most **US$0.25 total**. Every fallback crosses the same `createBudgetedTransport` instance. Unknown spend permanently locks that transport.
- Production host limits remain unchanged: **2500 input tokens**, 2048 output tokens, 20000 total turn tokens, 10 model steps, 10 tool calls, 45000 ms turn timeout, 256 continuation-reserve tokens. Discovery and compact observations are enabled; reference count is five. The native wire estimator uses `estimateBoundedInput` and `estimateNativeInput` just as the production host does.
- The configured three routes, provider lists, reasoning settings, and timeouts mirror `configured-ai-provider.ts`, without importing its production-initializing `client.ts`. In particular, last resort retains its 2800-output minimum; with the current 2048-output policy it is ineligible. The evaluator does **not** raise limits to make it eligible.
- A single source configuration is forked with `forTurn()` per message, resetting only failed-route memory. Credentials, routes, policy, and the shared budget transport remain the same.
- All turns use synthetic owner `fluent-eval-synthetic-owner`, Spanish, `America/Bogota`, and reference instant `2026-10-11T17:49:00Z` (12:49 PM local). This is a frozen reference, not wall-clock scheduling.
- Only typed reminder read/create/update/cancel tools are registered. All required reminder capabilities are present. Write authorization accepts only this synthetic owner and those three mutations. Unknown targets do not mutate records or increment successful write counts. Unsupported notice/nudge policies fail without writes.
- Domain requests actually determine the store contents and list scopes. The script does not substitute expected parameters or repair failed interpretations. Successful operation IDs are memoized; identical replay returns the original receipt without another write; conflicting replay is rejected. Receipts and checkpoints remain in memory and in the final report.
- Credentials are selected only at live runtime: `dotenv.parse` reads `.env`, then only `OPENROUTER_*` and a valid `sk-or-` `AI_API_KEY` are retained, with process environment overrides. Nothing is assigned into `process.env`; no database configuration is activated. Credential values, authentication headers, and raw provider exceptions are never reported.

## Explicit conversation and semantic expectations

The report embeds this complete script, expected facts, and every executed turn. IDs are deterministic synthetic allocation IDs: **A** is the first created record, **B** second, **C** third. Wrong allocations or earlier mistakes cause honest downstream failures rather than rebasing expectations onto model mistakes.

| Turn | Spanish user message | Required facts |
| --- | --- | --- |
| 1 | Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana | Exactly one create: A, preparar reunión, Oct 11 4 PM local (`21:00Z`). Host card plus typed reminders/today_or_tomorrow clarification and host question. |
| 2 | mañana | Exactly one create: B, enviar informe, Oct 12 9 AM local (`14:00Z`). A unchanged; no repeated clarification. |
| 3 | Muéstrame los recordatorios de hoy. | Read lists A only; no writes. |
| 4 | ¿Y los de mañana? Muéstramelos. | Read lists B only; no writes. |
| 5 | El primero de esa lista de mañana, cámbialo a las 10 AM de mañana. | Update B only to Oct 12 `15:00Z`; preserve its ID and content. |
| 6 | Ahora muéstrame los recordatorios de hoy otra vez. | Read lists A only. |
| 7 | Ese primero de hoy, pásalo a las 5 PM de hoy. | Update A only to Oct 11 `22:00Z`. |
| 8 | Lista todos mis recordatorios pendientes en orden de fecha y hora. | Read lists A then B, with stored content. |
| 9 | Cancela el segundo de esa lista. | Cancel B only, not A. |
| 10 | Muéstrame qué recordatorios quedan para mañana. | Actual read returns an empty list; no writes. |
| 11 | Recuérdame comprar pan mañana a las 8 AM. | Create C only, Oct 12 `13:00Z`. |
| 12 | Lista mis recordatorios de mañana. | Read lists C only. |
| 13 | Al primero de esa lista cámbiale solo el texto a Comprar pan integral. | Update C content only; time and ID unchanged. |
| 14 | Cancela el recordatorio con ID 99999999-9999-4999-8999-999999999999. Si no existe no cambies nada. | No write and no stored changes, whether rejected by the runner or port. |
| 15 | ¿Cómo se llama ahora el recordatorio del pan de mañana? | Reply includes pan integral; no writes. |
| 16 | Mi palabra de prueba en esta conversación es colibrí. Solo recuérdala aquí, sin crear ni cambiar recordatorios. | No writes; conversational context only, not a durable memory tool expectation. |
| 17 | ¿Cuál es mi palabra de prueba? | Reply includes colibrí; no writes. |
| 18 | Cancela el recordatorio Comprar pan integral de mañana. | Cancel C only. |
| 19 | Muéstrame todos mis recordatorios pendientes. | Read lists A only. |
| 20 | ¿A qué hora quedó el recordatorio de preparar reunión de hoy? No lo cambies. | Reply includes 5:00 PM; no writes. |

Every turn also checks unrelated records remain unchanged, exact successful write count, a valid transcript, no operational notices, and agreement between the returned host reply and completed durable checkpoint. Mutation checks preserve unrequested fields. Read checks compare returned IDs/order, stored record contents, and host-visible content. Reply checks are explicit normalized substrings, not another LLM judge; alternate correct paraphrases can therefore fail. Inspect the reply and checks before drawing conclusions.

## Report and stop semantics

Ordinary semantic failures remain in the report and **do not stop or retry the conversation**. Actual conversation state, including failed interpretations, feeds the next turn. Input/context/model-step limit notices mark the run degraded but do not increase limits or prevent subsequent user messages when accounting remains known. Provider unavailability, authentication failure, unknown accounting, exhausted HTTP/spend caps, or an unexpected host exception stop safely. An exception is reported, never silently retried.

Each turn's `toolSelections` retains safe loop decisions: rejected tool identifier, advertised identifiers, truncation flag, `reload_schema`/`stop`, categorical reason and accounting completeness. `safeAttempts` retains the provider error code plus the classifier-validated rejected name and advertised scope. Identifier lists are bounded to 64 entries; raw vendor messages, rejected arguments and credentials are excluded. A schema-reload decision does not guarantee another HTTP dispatch: unchanged loop limits and the unknown-spend transport lock may still stop it. See [scope and recovery diagnostics](v2-context-budget.md#rejection-and-recovery-evidence).

The report includes per-turn checks/pass flags, reply, notices, tool calls, safe source attempts, tool-selection decisions, HTTP transport attempts, budget snapshots, usage, store before/after, actual port operations, and checkpoint snapshots; plus all receipts, final conversation/store, aggregate check/turn pass/fail counts, limits, and the transport accounting report. In directed mode, `incomplete` is measured against 2 turns and the script/limits contain only that plan. `directedProof` requires both turns to pass with at least one fully accounted HTTP request, no outstanding reservation, no exception and no stop condition. It does not establish 20-turn acceptance. In full mode, `directedProof` stays false. `liveRequested` records mode selection; `liveProof` is true only for an actual live run with all 20 turns passing, at least one accounted HTTP call, no outstanding reservation, no exception, and no stop condition. Selecting live mode alone never establishes proof. Transport attempts expose returned `responseModel`, generation IDs, token totals/cost where available, and accounting status. Configured aliases alone do not prove an exact model version/build; missing returned metadata is not invented. A synthetic accepted delivery is not WhatsApp delivery evidence.

Once a valid new output path is established, the CLI attempts to write its report in `finally`, including preflight or incomplete/exception flags. If writing fails, it prints a bounded diagnostic and returns nonzero; **do not automatically rerun a paid evaluation**. No report is promised for an invalid output path. A completed offline fixture is never live acceptance evidence.

## Offline verification

```bash
./node_modules/.bin/vitest run --config tests/config/vitest.unit.ts tests/unit/agent-core/fluent-evaluation.test.ts
node --import tsx scripts/evals/v2-fluent-conversation.ts --help
./node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit --pretty false
```

The deterministic fixture exercises the actual durable two-turn mixed clarification and then continues through all 20 messages despite intentionally failing subsequent semantic expectations. It also checks safe default/help behavior, limit-override rejection, typed port mutation/replay/rejection behavior, and negative grader cases. It does not invoke the live command or prove provider billing correctness.
