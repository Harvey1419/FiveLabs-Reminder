import { ESLint, type Linter } from 'eslint';
import { createRequire } from 'node:module';
import { z } from 'zod';

// The parser uses the TS 6 API at runtime. Its ambient DOM declarations must not
// enter the application's TS 7 compilation graph. Validate this module boundary.
type Parser = NonNullable<NonNullable<Linter.Config['languageOptions']>['parser']>;
type Plugin = NonNullable<Linter.Config['plugins']>[string];
const moduleValue: unknown = createRequire(import.meta.url)('typescript-eslint');
const tseslint = z.object({
  parser: z.custom<Parser>(value => value !== null && typeof value === 'object'
    && 'parseForESLint' in value && typeof value.parseForESLint === 'function'),
  plugin: z.custom<Plugin>(value => value !== null && typeof value === 'object' && 'rules' in value),
}).parse(moduleValue);

/** Syntax/safety lint baseline for the migrated repo; compiler strictness is checked separately. */
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  files: ['**/*.ts'],
  ignores: ['**/dist/**', '**/node_modules/**', '**/.*/**'],
  languageOptions: { parser: tseslint.parser },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'no-async-promise-executor': 'error',
    'no-dupe-args': 'error',
    'no-dupe-else-if': 'error',
    'no-duplicate-case': 'error',
    'no-loss-of-precision': 'error',
    'no-sparse-arrays': 'error',
    'no-unreachable': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
  },
}] });
const results = await lint.lintFiles(['src/**/*.ts', 'packages/*/src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', '*.ts']);
const formatter = await lint.loadFormatter('stylish');
const output = formatter.format(results);
if (output) console.log(output);
const errors = results.reduce((count, result) => count + result.errorCount, 0);
const warnings = results.reduce((count, result) => count + result.warningCount, 0);
console.log(JSON.stringify({ lintedFiles: results.length, errors, warnings }));
if (errors || warnings) process.exitCode = 1;
