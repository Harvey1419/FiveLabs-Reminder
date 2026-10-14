import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const targets = new Map([
  ['src/agent/orchestration/router.ts', 'canary_entry'],
  ['src/agent/orchestration/router-core.ts', 'baseline_engine'],
  ['src/agent/tools/index.ts', 'generic_dispatch'],
  ['src/agent/core/agent-run.ts', 'legacy_active_runs'],
]);
const edges: { file: string; line: number; target: string; kind: string }[] = [];
function scan(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { scan(file); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const add = (specifier: string, node: ts.Node) => {
      if (!specifier.startsWith('.')) return;
      const target = relative(root, resolve(dirname(file), specifier.replace(/\.js$/, '.ts'))).replaceAll('\\', '/');
      const kind = targets.get(target);
      if (kind) edges.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, target, kind });
    };
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (!(bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly))) add(node.moduleSpecifier.text, node);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.exportClause;
        if (!(bindings && ts.isNamedExports(bindings) && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly))) add(node.moduleSpecifier.text, node);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text, node);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
scan('src'); scan('scripts');
edges.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const file = 'config/v1-retirement-callers.json';
const inventory = { version: 1, scope: 'Runtime imports of V1 entry/dispatch/run modules in src and scripts; type-only imports excluded', edges };
if (process.argv.includes('--write')) writeFileSync(file, JSON.stringify(inventory, null, 2) + '\n');
else {
  const known: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (JSON.stringify(known) !== JSON.stringify(inventory)) throw new Error('V1 caller inventory changed. Review callers and run pnpm run inventory:v1 --write.');
}
console.log(JSON.stringify({ v1CallerEdges: edges.length, inventory: file, reviewed: !process.argv.includes('--write') }));
