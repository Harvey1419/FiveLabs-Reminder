console.warn('\x1b[33m[DEPRECATION NOTICE] scripts/evals/agent-production.ts relied on legacy turn manifests (v1).\x1b[0m');
console.warn('For offline validation, use `npm run eval:smoke`. For an authorized live comparison, use `node --import tsx scripts/evals/groq-contract/runner.ts`.');
process.exit(0);
