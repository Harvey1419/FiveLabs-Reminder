import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = ['src', 'scripts', 'tests', 'packages'];
const skipped = new Set(['node_modules', 'dist', 'coverage']);
const javascript: string[] = [];
const typescript: string[] = [];

function scan(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) scan(path);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) javascript.push(path);
    else if (/\.(?:ts|mts|cts)$/.test(entry.name)) typescript.push(path);
  }
}

// Run from the project root. Missing maintained roots should fail visibly.
if (resolve(process.cwd()) !== resolve(fileURLToPath(new URL('../..', import.meta.url)))) {
  throw new Error('Run the migration inventory from the repository root');
}
for (const root of roots) scan(root);
// Root-level executable configuration is maintained source too.
for (const entry of readdirSync('.', { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (/\.(?:js|mjs|cjs)$/.test(entry.name)) javascript.push(entry.name);
  else if (/\.(?:ts|mts|cts)$/.test(entry.name)) typescript.push(entry.name);
}
console.log(JSON.stringify({
  roots,
  remainingJavaScript: javascript.sort(),
  typeScriptSources: typescript.sort(),
  counts: { javascript: javascript.length, typescript: typescript.length },
}, null, 2));

// Optional completion gate. Keep inventory usable while migration is in progress.
if (process.argv.includes('--check') && javascript.length > 0) {
  console.error(`Full TypeScript migration remains open: ${javascript.length} maintained JavaScript files.`);
  process.exitCode = 1;
}
