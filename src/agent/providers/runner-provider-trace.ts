import { openSync, writeSync, closeSync, lstatSync, realpathSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import type { GatewayAttemptOptions, GatewayAttemptResult } from './gateway-attempt.js';
import type { GatewayEnvironment } from './gateway-routing.js';

export interface RunnerProviderTraceDependencies {
  traceEntrypoint: string; getEnvironment(): GatewayEnvironment; getArgv(): readonly string[]; getUid(): number | undefined;
  onceExit(callback: () => void): void; removeExit(callback: () => void): void; logger: Pick<Console, 'warn'>;
  performOpenRouterAttempt(messages: readonly unknown[], model: string, apiKey: string, options: GatewayAttemptOptions): Promise<GatewayAttemptResult>;
}
interface OpenTrace {
  directory: string; fd: number; closed: boolean; events: number; bytes: number; missing: number; ioError: boolean; calls: number; pending: number;
  write(text: string): void;
  emit(metadata: Record<string, unknown>, type: string, evidence: Record<string, unknown>, apiKey: string): void;
}
interface FailedTrace { directory: string; closed: true }

/** Trace IO remains gated by the original synthetic-child identity and private-directory checks. */
export function createRunnerProviderTrace({ traceEntrypoint, getEnvironment, getArgv, getUid, onceExit, removeExit, logger, performOpenRouterAttempt }: RunnerProviderTraceDependencies) {
  const TRACE_BYTES = 8 * 1024 * 1024;
  const TRACE_EVENT_BYTES = 256 * 1024;
  const TRACE_EVENTS = 1200;
  let runnerTrace: OpenTrace | FailedTrace | null = null;

  function finalizeRunnerProviderTrace(): void {
    const trace = runnerTrace;
    if (!trace || trace.closed) return;
    trace.closed = true;
    removeExit(finalizeRunnerProviderTrace);
    try {
      const summary = JSON.stringify({ type: 'completeness', complete: !trace.missing && !trace.ioError && !trace.pending,
        unfinishedCalls: trace.pending, events: trace.events, bytesBeforeSummary: trace.bytes, missingEvents: trace.missing,
        ioError: trace.ioError, limits: { bytes: TRACE_BYTES, eventBytes: TRACE_EVENT_BYTES, events: TRACE_EVENTS },
        responseEnvelope: 'not_captured; raw decision only', headers: 'never_captured' }) + '\n';
      trace.write(summary);
    } catch { logger.warn('Provider trace incomplete: finalization_io_error'); }
    finally { try { closeSync(trace.fd); } catch { /* already reported as incomplete */ } }
  }

  function getRunnerTrace(): OpenTrace | null {
    const environment = getEnvironment();
    const directory = environment.HERMES_CHAT_PROVIDER_TRACE_DIR;
    if (!directory) return null;
    const phone = environment.HERMES_CHAT_TEST_PHONE;
    if (resolve(getArgv()[1] || '') !== traceEntrypoint
      || environment.HERMES_CHAT_DISABLE_REMINDER_SCHEDULER !== '1'
      || !/^hermes-chat\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(phone || '')) return null;
    if (runnerTrace?.directory === directory) return runnerTrace.closed ? null : runnerTrace;
    if (runnerTrace && !runnerTrace.closed) return null;
    // Remember initialization failures too: trace IO must never cause a retry.
    runnerTrace = { directory, closed: true };
    try {
      const canonicalTmp = realpathSync(tmpdir());
      const stat = lstatSync(directory);
      if (dirname(directory) !== canonicalTmp || realpathSync(directory) !== directory
        || !basename(directory).startsWith(`hermes-provider-trace-${phone}-`)
        || !/^[a-zA-Z0-9.-]+$/.test(basename(directory))
        || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
        || stat.uid !== getUid()) throw new Error('unsafe_directory');
      const fd = openSync(join(directory, 'events.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const trace = { directory, fd, closed: false, events: 0, bytes: 0, missing: 0, ioError: false, calls: 0, pending: 0 } as OpenTrace;
      trace.write = text => {
        const bytes = Buffer.from(text, 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('short_write');
          offset += written;
        }
        trace.bytes += bytes.length;
      };
      trace.emit = (metadata, type, evidence, apiKey) => {
        if (trace.closed || trace.ioError) { trace.missing++; return; }
        try {
          if (evidence.missing) trace.missing++;
          const serialized = JSON.stringify({ ...metadata, type, complete: !evidence.missing, ...evidence });
          const evidenceBytes = Buffer.byteLength(serialized);
          let line = serialized + '\n';
          const missing = serialized.includes(apiKey) ? 'credential_in_evidence' : evidenceBytes > TRACE_EVENT_BYTES ? 'event_byte_limit' : null;
          if (missing) {
            trace.missing++;
            // Do not silently redact or truncate protocol evidence.
            line = JSON.stringify({ call: metadata.call, type, complete: false, missing, originalBytes: evidenceBytes }) + '\n';
          }
          if (trace.events >= TRACE_EVENTS || trace.bytes + Buffer.byteLength(line) > TRACE_BYTES - 2048) {
            trace.missing++; return;
          }
          trace.write(line);
          trace.events++;
        } catch {
          trace.ioError = true; trace.missing++;
          logger.warn('Provider trace incomplete: event_io_error');
        }
      };
      runnerTrace = trace;
      onceExit(finalizeRunnerProviderTrace);
      return trace;
    } catch {
      logger.warn('Provider trace incomplete: initialization_failed (no evidence file opened)');
      return null;
    }
  }

  async function callOpenRouterAttempt(messages: readonly unknown[], model: string, apiKey: string, options: GatewayAttemptOptions = {}): Promise<GatewayAttemptResult> {
    const trace = getRunnerTrace();
    const state = { response: false, validation: false };
    if (trace) trace.pending++;
    const metadata = trace ? { call: ++trace.calls, purpose: options.purpose || 'unspecified',
      correlationId: options.correlationId ?? null, model, provider: options.providers || [],
      stage: options.stage || 'direct', attempt: options.attemptNumber || 1 } : null;
    const capture = trace ? (type: string, evidence: Record<string, unknown>) => {
      if (type === 'response') state.response = true;
      if (type === 'validation') state.validation = true;
      trace.emit(metadata!, type, evidence, apiKey);
    } : null;
    const result = await performOpenRouterAttempt(messages, model, apiKey, { ...options, capture });
    capture?.('outcome', { ok: result.ok, reason: result.reason ?? null,
      ...(!state.response ? { missing: 'response_decision_unavailable' } : {}),
      terminal: Boolean(result.terminal), response: state.response ? 'captured_or_marked_missing' : 'missing_transport_or_json_failure',
      validation: state.validation ? 'captured_or_marked_missing' : 'not_run' });
    if (trace) trace.pending--;
    return result;
  }

  return { callOpenRouterAttempt, finalizeRunnerProviderTrace };
}
