import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const image = process.argv[2];
if (!image) throw new Error('Usage: pnpm run smoke:container <image>');
function docker(...args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout.trim();
}
// Only empty external fixtures are available. The container has no network access.
const bootstrap = `
import assert from 'node:assert/strict';
const accepted = new Set(['hermes_inbound_queue_version', 'claim_hermes_inbound_turn', 'claim_next_pending_reminder']);
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = options?.method || (input instanceof Request ? input.method : 'GET');
  assert.equal(url.origin, 'https://container-smoke.supabase.co');
  let body;
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const rpc = url.pathname.split('/').at(-1);
    assert.ok(accepted.has(rpc), 'Unexpected RPC: ' + rpc);
    body = rpc === 'hermes_inbound_queue_version' ? 1 : [];
  } else {
    assert.equal(method, 'GET');
    assert.ok(['/rest/v1/hermes_inbound_turns','/rest/v1/reminders','/rest/v1/users','/rest/v1/user_integrations'].includes(url.pathname));
    body = [];
  }
  return new Response(JSON.stringify(body), {status:200,headers:{'content-type':'application/json'}});
};
process.on('exit', code => console.log(JSON.stringify({smokeExitCode:code})));
`;
const healthProbe = `
import {get} from 'node:http';
get('http://127.0.0.1:3005/health',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{
  console.log(JSON.stringify({status:r.statusCode,body:JSON.parse(b)}));
  process.exit(r.statusCode===200?0:1);
});}).on('error',()=>process.exit(1));
`;
const directory = mkdtempSync(join(tmpdir(), 'hermes-container-smoke-'));
let container: string | null = null;
try {
  const file = join(directory, 'bootstrap.mjs');
  writeFileSync(file, bootstrap);
  // Resolve the mutable tag once; all checks execute this immutable artifact.
  const imageId = docker('image', 'inspect', '--format', '{{.Id}}', image);
  container = docker('create', '--network', 'none',
    '-e', 'NODE_ENV=production', '-e', 'PORT=3005',
    '-e', 'NODE_OPTIONS=--max-old-space-size=96 --import=/tmp/container-smoke-bootstrap.mjs',
    '-e', 'SUPABASE_URL=https://container-smoke.supabase.co', '-e', 'SUPABASE_SECRET=synthetic',
    '-e', 'KAPSO_API_KEY=synthetic', '-e', 'OPENROUTER_API_KEY=synthetic', imageId);
  docker('cp', file, `${container}:/tmp/container-smoke-bootstrap.mjs`);
  docker('start', container);
  let health: unknown = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      health = JSON.parse(docker('exec', '-e', 'NODE_OPTIONS=--max-old-space-size=96', container,
        'node', '--input-type=module', '-e', healthProbe));
      break;
    } catch { await pause(500); }
  }
  assert.deepEqual(health, { status: 200, body: { status: 'ok' } });
  const audit = JSON.parse(docker('exec', '-e', 'NODE_OPTIONS=--max-old-space-size=96', container,
    'node', '--input-type=module', '-e', `
import {existsSync,readFileSync} from 'node:fs';
console.log(JSON.stringify({node:process.versions.node,pid1:readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean),
source:existsSync('src'),compiler:existsSync('node_modules/typescript'),tsx:existsSync('node_modules/tsx')}));`));
  assert.match(audit.node, /^22\./);
  assert.deepEqual(audit.pid1, ['node', 'dist/runtime/app/server.js']);
  assert.equal(audit.source, false); assert.equal(audit.compiler, false); assert.equal(audit.tsx, false);
  const before = Date.now();
  docker('kill', '--signal', 'SIGTERM', container);
  const exitCode = Number(docker('wait', container));
  const shutdownMs = Date.now() - before;
  assert.equal(exitCode, 0); assert.ok(shutdownMs < 25000);
  assert.equal(docker('inspect', '--format', '{{.State.OOMKilled}}', container), 'false');
  assert.ok(docker('logs', container).includes('"smokeExitCode":0'));
  console.log(JSON.stringify({ imageId, node: audit.node, health, exitCode, shutdownMs, network: 'none', syntheticDependencies: true }));
} catch (error) {
  if (container) console.error(docker('logs', container));
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
  rmSync(directory, { recursive: true, force: true });
}
