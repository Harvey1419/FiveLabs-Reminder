import 'dotenv/config';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import type { JsonObject } from '@templelabs/contracts';

interface RecoveryResult { data: unknown; error: { message: string } | null }
interface RecoveryQuery extends PromiseLike<RecoveryResult> {
  select(columns: string): RecoveryQuery;
  in(column: string, values: string[]): RecoveryQuery;
}
interface RecoveryClient {
  from(table: 'hermes_inbound_turns'): RecoveryQuery;
  rpc(name: string, args: JsonObject): PromiseLike<RecoveryResult>;
}
const sdkPackage = '@supabase/supabase-js';
const { createClient } = await import(sdkPackage) as { createClient(url: string, secret: string, options: { auth: { persistSession: false; autoRefreshToken: false }; global: { fetch: typeof fetch } }): RecoveryClient };
import { z } from 'zod';
import { jsonObjectSchema } from '@templelabs/contracts';

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error('Usage: resolve-rejected-transport.ts evidence.json receipt.json');
const input = z.object({ userId: z.uuid(), targets: z.array(z.object({ id: z.uuid(), rejection: z.object({
  source: z.literal('railway_provider_error_log'), provider: z.literal('Kapso'), httpStatus: z.literal(400), providerCode: z.literal(100),
  message: z.literal('Param text.body must be at most 4096 characters long.'), correlationId: z.uuid(), loggedAtUtc: z.iso.datetime(),
}) })).length(2) }).parse(JSON.parse(await readFile(args[0]!, 'utf8')));
const env = z.object({ SUPABASE_URL: z.url(), SUPABASE_SECRET: z.string().min(1) }).parse(process.env);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET, { auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) } });
const read = await db.from('hermes_inbound_turns').select('id,status,response').in('id', input.targets.map(target => target.id));
if (read.error) throw new Error(read.error.message);
const rows = z.array(z.object({ id: z.uuid(), status: z.string(), response: jsonObjectSchema })).length(2).parse(read.data);
if (rows.some(row => row.status !== 'unknown')) throw new Error('Expected two unresolved historical rows; no changes made');
const owner = input.targets[0]!;
const original = (id: string) => rows.find(row => row.id === id)!.response;
const claimed = await db.rpc('lease_hermes_rejected_transport_turn', { p_target_id: owner.id, p_user_id: input.userId, p_expected_response: original(owner.id) });
if (claimed.error) throw new Error(claimed.error.message);
const lease = z.object({ ownerId: z.uuid(), token: z.uuid(), threadId: z.string().min(1) }).parse(claimed.data);
// Close the lease-owning old turn LAST; it fences both independent evidence-based resolutions.
for (const target of [...input.targets].reverse()) {
  const resolved = await db.rpc('resolve_hermes_rejected_transport_turn', { p_owner_id: lease.ownerId, p_owner_token: lease.token,
    p_target_id: target.id, p_user_id: input.userId, p_expected_response: original(target.id), p_rejection: target.rejection });
  if (resolved.error || resolved.data !== true) throw new Error(`Resolution failed for ${target.id}; preserve lease/checkpoints for inspection`);
}
const final = await db.from('hermes_inbound_turns').select('id,status,response').in('id', input.targets.map(target => target.id));
if (final.error) throw new Error(final.error.message);
const verified = z.array(z.object({ id: z.uuid(), status: z.literal('completed'), response: jsonObjectSchema })).length(2).parse(final.data);
const evidence = verified.map(row => {
  const restored = { ...row.response }; delete restored.agentCoreTransportRejected; delete restored.transportRecoveryLease;
  if (!isDeepStrictEqual(restored, original(row.id))) throw new Error('Original source evidence changed');
  return { id: row.id, status: row.status, resolution: row.response.agentCoreTransportRejected, originalEvidencePreserved: true };
});
const receipt = { verifiedAtUtc: new Date().toISOString(), leaseOwnerId: lease.ownerId, targets: evidence,
  replayedMessages: 0, executedDomainMutations: 0, sentWhatsAppMessages: 0 };
await writeFile(args[1]!, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ resolved: verified.length, originalEvidencePreserved: true, receipt: args[1] }));
