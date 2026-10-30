import { readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
// Application directories in apps/. Each application gets its own alias rules.
const apps = readdirSync(new URL('../apps/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const testFiles = ['apps/*/test/**/*.{js,mjs,ts}', 'tests/**/*.{js,mjs,ts}'];
const cyrillic = '[\\u0400-\\u04FF]';

const syntaxRestrictions = [
  { selector: "MethodDefinition[kind='set']", message: 'Use an explicit method instead of a property setter.' },
  { selector: "Property[kind='set']", message: 'Use an explicit method instead of a property setter.' },
  {
    selector:
      "Identifier[name='arguments']:not(MemberExpression[computed=false] > Identifier.property):not(Property[computed=false] > Identifier.key):not(MethodDefinition[computed=false] > Identifier.key):not(TSPropertySignature > Identifier.key)",
    message: 'Use explicit parameters or rest parameters.'
  },
  {
    selector: "CallExpression[arguments.length>2][callee.type='MemberExpression'][callee.object.name='Object'][callee.property.name='assign'][callee.computed=false]",
    message: 'Use at most two Object.assign arguments. Split the changes into explicit steps.'
  },
  {
    selector: "CallExpression[arguments.length>2][callee.type='MemberExpression'][callee.object.name='Object'][callee.property.value='assign'][callee.computed=true]",
    message: 'Use at most two Object.assign arguments. Split the changes into explicit steps.'
  },
  {
    selector: "Property[key.name='shell']:not([value.value=false])",
    message: 'Do not start subprocesses through a shell. Give the program and an argument array.'
  },
  {
    selector: 'ImportDeclaration[source.value=/^(node:)?child_process$/] > ImportDefaultSpecifier',
    message: 'Import named child_process functions so that the shell-based functions stay blocked.'
  }
];

// Match test('name'), test.skip('name'), describe('name'), and t.test('name') for node:test subtests.
const testCall = "CallExpression:matches([callee.name=/^(test|it|describe|suite)$/], [callee.object.name=/^(test|it|describe|suite)$/], [callee.object.name='t'][callee.property.name='test'])";
const testNameRestrictions = [
  {
    selector: `${testCall} > Literal.arguments:first-child[value=/${cyrillic}/]`,
    message: 'Write test names in English. Use Russian only in assertions that match Russian interface text.'
  },
  {
    selector: `${testCall} > TemplateLiteral.arguments:first-child > TemplateElement[value.raw=/${cyrillic}/]`,
    message: 'Write test names in English. Use Russian only in assertions that match Russian interface text.'
  }
];

const builtinPaths = [
  ...builtinModules.filter((name) => !name.startsWith('_') && !name.startsWith('node:')).map((name) => ({ name, message: `Use the node:${name} import.` })),
  ...['node:child_process', 'child_process'].map((name) => ({
    name,
    importNames: ['exec', 'execSync'],
    message: 'These functions start a shell. Use execFile, spawn, or spawnSync with an argument array.'
  }))
];

// One option object for no-restricted-imports, because a later configuration block replaces the rule options.
function restrictedImports({ app, source = false } = {}) {
  const patterns = [];
  if (app) {
    const others = apps.filter((name) => name !== app);
    patterns.push({ group: ['@/*', '@/'], message: `Use the @${app}/* application alias. A generic @ alias is not permitted.` });
    if (others.length) {
      patterns.push({
        group: others.flatMap((name) => [`@${name}`, `@${name}/*`, `../../${name}/**`, `**/apps/${name}/**`]),
        message: 'Do not import another application. Move common code to @shared.'
      });
    }
  }
  if (app && source) {
    const name = `tx-${app.toLowerCase()}`;
    patterns.push({ group: [`${name}/*`, './*', '../*'], message: `Use the @${app}/* application alias for runtime modules.` });
    return ['error', { paths: [...builtinPaths, { name, message: `Use the @${app}/* application alias.` }], patterns }];
  }
  return ['error', { paths: builtinPaths, patterns }];
}

// Report Cyrillic text in comments. Comments and documentation are in English.
const englishComments = {
  meta: { type: 'suggestion', schema: [], messages: { english: 'Write code comments in English.' } },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (new RegExp(cyrillic).test(comment.value)) context.report({ loc: comment.loc, messageId: 'english' });
        }
      }
    };
  }
};

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/reports/**', '.agents/**', '.claude/**', '.codex/**', '.gemini/**'] },
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    plugins: { 'simple-import-sort': simpleImportSort, toolchain: { rules: { 'english-comments': englishComments } } },
    rules: {
      'consistent-return': 'error',
      'no-useless-computed-key': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-restricted-syntax': ['error', ...syntaxRestrictions],
      'no-restricted-imports': restrictedImports(),
      'toolchain/english-comments': 'error'
    }
  },
  {
    files: testFiles,
    rules: { 'no-restricted-syntax': ['error', ...syntaxRestrictions, ...testNameRestrictions] }
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/naming-convention': ['error', { selector: 'typeAlias', format: ['PascalCase'] }]
    }
  },
  {
    files: ['apps/*/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: repositoryRoot }
    },
    rules: {
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
    }
  },
  {
    files: ['apps/*/src/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // These rules trust static types over runtime values. Keep runtime checks of untrusted input, platform constants, and TTY state.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-useless-default-assignment': 'off'
    }
  },
  ...apps.flatMap((app) => [
    { files: [`apps/${app}/**/*.{js,mjs,ts}`], rules: { 'no-restricted-imports': restrictedImports({ app }) } },
    { files: [`apps/${app}/src/**/*.ts`], rules: { 'no-restricted-imports': restrictedImports({ app, source: true }) } }
  ]),
  prettier
]);
