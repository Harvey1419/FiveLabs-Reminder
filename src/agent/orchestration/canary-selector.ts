import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({ version: z.literal(1), targeting: z.object({
  percentage: z.union([z.literal(0), z.literal(100)]), userAllowlist: z.array(z.string().trim().min(1)).max(1000),
}) });
const allowlistSchema = z.array(z.string().trim().min(1)).max(1000);
export interface CanaryPolicy { enabled: boolean; userAllowlist: readonly string[]; percentage?: 0 | 100 }

/** Read on every admission: false is immediate for new turns; invalid configuration fails closed. */
export function readCanaryPolicy(env: Readonly<Record<string, string | undefined>> = process.env,
  readConfig: () => string = () => readFileSync(resolve(process.cwd(), 'config/agent-core-v2-canary.json'), 'utf8')): CanaryPolicy {
  if (env.AGENT_CORE_V2 !== 'true') return { enabled: false, userAllowlist: [] };
  try {
    const config = configSchema.parse(JSON.parse(readConfig()));
    const userAllowlist = env.AGENT_CORE_V2_ALLOWLIST === undefined ? config.targeting.userAllowlist
      : allowlistSchema.parse(JSON.parse(env.AGENT_CORE_V2_ALLOWLIST));
    // An explicit environment allowlist replaces global targeting too; [] always clears admission.
    const percentage = env.AGENT_CORE_V2_ALLOWLIST === undefined ? config.targeting.percentage : 0;
    return { enabled: true, userAllowlist, percentage };
  } catch { return { enabled: false, userAllowlist: [] }; }
}

export function selectCanaryEngine(policy: CanaryPolicy, user: unknown): 'baseline' | 'v2' {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(user);
  return policy.enabled && parsed.success && (policy.percentage === 100 || policy.userAllowlist.includes('*') || policy.userAllowlist.includes(parsed.data.id)) ? 'v2' : 'baseline';
}
