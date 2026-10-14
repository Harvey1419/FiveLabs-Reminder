import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

/** Build gate: production imports must stay within emitted application code or production dependencies. */
const runtimeRoot = resolve('dist/runtime');
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
const visited = new Set<string>();
const external = new Set<string>();
function inspectSpecifier(specifier: string, importer: string): void {
  if (specifier.startsWith('.')) {
    visit(resolve(dirname(importer), specifier));
    return;
  }
  if (!specifier.startsWith('node:') && specifier !== 'crypto') {
    const parts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (!Object.hasOwn(manifest.dependencies, packageName)) throw new Error(`Non-production dependency ${specifier} in ${relative(runtimeRoot, importer)}`);
  }
  external.add(specifier);
}
function visit(file: string): void {
  if (visited.has(file)) return;
  const path = relative(runtimeRoot, file);
  if (path.startsWith(`..${sep}`) || path === '..') throw new Error(`Runtime import escapes compiled application: ${file}`);
  if (!existsSync(file)) throw new Error(`Missing compiled runtime module: ${path}`);
  visited.add(file);
  const source = readFileSync(file, 'utf8');
  // TypeScript emits these static import/export forms on individual lines.
  const imports = /^(?:import\s+[^;\n]*?\s+from|export\s+(?:\{[^}\n]*\}|\*(?:\s+as\s+\w+)?)\s+from)\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(imports)) inspectSpecifier((match[1] || match[2])!, file);
  // Lazy engine imports are production paths too; validate their emitted dependency graph.
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) inspectSpecifier(match[1]!, file);
  // Explicit SDK constructor bridges also have to resolve production dependencies.
  for (const match of source.matchAll(/createRequire\(import\.meta\.url\)\(['"]([^'"]+)['"]\)/g)) inspectSpecifier(match[1]!, file);
}
visit(resolve(runtimeRoot, 'app/server.js'));
console.log(JSON.stringify({ entrypoint: 'dist/runtime/app/server.js', compiledModules: visited.size, externalImports: [...external].sort(), sourceHostImports: 0, missingRuntimeModules: 0 }));
