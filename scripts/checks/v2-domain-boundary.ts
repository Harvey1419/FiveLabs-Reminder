import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(process.argv[2] ?? 'dist/runtime');
const pending = [resolve(root, 'adapters/agent-core/canary-productivity-router.js')];
const seen = new Set<string>();
const forbidden = ['agent/tools/index.js', 'agent/tools/tool-dispatch.js', 'agent/orchestration/router-core.js'];
while (pending.length) {
  const file = pending.pop()!;
  if (seen.has(file)) continue;
  seen.add(file);
  const name = relative(root, file).replaceAll('\\', '/');
  assert.ok(!forbidden.includes(name) && !/^adapters\/agent-core\/legacy-/.test(name), `V2 domain depends on V1: ${name}`);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers: string[] = [];
  const constants = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer))
        constants.set(declaration.name.text, declaration.initializer.text);
    }
  }
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) specifiers.push(argument.text);
      else {
        // The SDK boundary uses a module-level literal const to avoid browser type leakage.
        // Nested imports cannot borrow this exemption because a local name may shadow it.
        let topLevel = true;
        for (let ancestor: ts.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent)
          if (ts.isFunctionLike(ancestor) || ts.isBlock(ancestor)) topLevel = false;
        const constant = argument && ts.isIdentifier(argument) && topLevel ? constants.get(argument.text) : undefined;
        assert.ok(constant, `Unbounded dynamic V2 import: ${name}`);
        specifiers.push(constant);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  // Includes bare imports, re-exports and lazy imports, without matching comments/string data.
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue;
    const child = resolve(dirname(file), specifier);
    assert.ok(child.startsWith(root + sep), `V2 domain import escapes compiled runtime: ${specifier}`);
    assert.ok(existsSync(child), `Missing V2 domain module: ${relative(root, child)}`);
    pending.push(child);
  }
}
console.log(JSON.stringify({ entrypoint: 'canary-productivity-router', checkedModules: seen.size, forbiddenV1Imports: 0 }));
