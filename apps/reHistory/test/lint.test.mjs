import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });
const source = 'apps/reHistory/src/engine.ts';

async function messages(code, filePath = source) {
  const [result] = await eslint.lintText(code, { filePath });
  expect(result.messages.filter((message) => message.fatal)).toEqual([]);
  return result.messages;
}

test('the configuration checks spread types, return types, and type exports', async () => {
  const errors = await messages('type Item = string;\nexport { Item };\nexport function result() { return { ...[1, 2] }; }\n');
  expect(errors.map((error) => error.ruleId)).toEqual(
    expect.arrayContaining(['@typescript-eslint/no-misused-spread', '@typescript-eslint/explicit-function-return-type', '@typescript-eslint/consistent-type-exports'])
  );
});

test('type imports, import sorting, and the self-package import ban apply together', async () => {
  const errors = await messages(
    "import { Repository } from '@reHistory/engine';\nimport { readFileSync } from 'node:fs';\nimport 'tx-rehistory';\nexport const read = readFileSync;\nexport type Repo = Repository;\n"
  );
  expect(errors.map((error) => error.ruleId)).toEqual(expect.arrayContaining(['@typescript-eslint/consistent-type-imports', 'simple-import-sort/imports', 'no-restricted-imports']));
});

test('runtime modules require the alias, and test fixtures permit relative imports', async () => {
  const code = "import './fixture.js';\n";
  expect((await messages(code)).map((error) => error.ruleId)).toContain('no-restricted-imports');
  expect(await messages(code, 'apps/reHistory/test/unit.test.ts')).toEqual([]);
});

test('Node.js files do not get browser globals', async () => {
  const errors = await messages('window.alert("unsafe");\n', 'configs/lint-fixture.mjs');
  expect(errors.map((error) => error.ruleId)).toContain('no-undef');
});

test('setter, arguments, and Object.assign restrictions apply without another plugin', async () => {
  const errors = await messages(
    "export const value = { set field(value) { console.log(value); } };\nexport function read() { return arguments[0]; }\nObject.assign({}, {a: 1}, {b: 2});\nObject['assign']({}, {a: 1}, {b: 2});\n",
    'configs/lint-fixture.mjs'
  );
  expect(errors.filter((error) => error.ruleId === 'no-restricted-syntax')).toHaveLength(4);
});

test('CLI code permits mutation, a signal getter, rest parameters, and Russian text', async () => {
  const errors = await messages(
    "export function status(...values: string[]): { readonly interrupted: boolean } {\nconst state = { interrupted: false };\nvalues.push('Ввод отменён.');\nObject.assign(state, { interrupted: true });\nreturn { get interrupted(): boolean { return state.interrupted; } };\n}\n"
  );
  expect(errors).toEqual([]);
  expect(await messages('export const value: { arguments: string[] } = { arguments: [] };\nvalue.arguments.push("значение");\n')).toEqual([]);
});

test('exceptions do not hide any, unused variables, or mixed returns', async () => {
  const errors = await messages('export function read(value: any): unknown { const unused = 1; if (value) return value; return; }\n');
  expect(errors.map((error) => error.ruleId)).toEqual(expect.arrayContaining(['@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unused-vars', 'consistent-return']));
});

test('the configuration works from the application directory and needs no types for JS tool files', async () => {
  const local = new ESLint({ cwd: fileURLToPath(new URL('../', import.meta.url)) });
  const [result] = await local.lintText('export const value: number = 1;\n', { filePath: 'src/engine.ts' });
  expect(result.messages).toEqual([]);
  expect(await messages('export const value = process.platform;\n', 'configs/lint-fixture.mjs')).toEqual([]);
  expect(await messages('export const value: number = 1;\n', 'tests/skills/skill-scanner.test.ts')).toEqual([]);
});

test('generated files and vendored skills stay outside ESLint', async () => {
  for (const path of ['apps/reHistory/dist/src/cli.js', 'node_modules/fixture/index.js', '.agents/skills/fixture/index.ts', 'coverage/index.js', 'reports/index.js']) {
    expect(await eslint.isPathIgnored(fileURLToPath(new URL(path, new URL('../../../', import.meta.url))))).toBe(true);
  }
  const config = await eslint.calculateConfigForFile(source);
  expect(Object.keys(config.plugins)).toEqual(expect.arrayContaining(['@typescript-eslint', 'simple-import-sort']));
  expect(Object.keys(config.plugins)).not.toContain('spellcheck');
});

test('application source uses strict type-checked rules', async () => {
  const errors = await messages(
    'export function read(map: Map<string, string>, key: string): string {\n  return map.get(key)!;\n}\nexport function label(value: unknown): string {\n  return `${value}`;\n}\n'
  );
  expect(errors.map((error) => error.ruleId)).toEqual(expect.arrayContaining(['@typescript-eslint/no-non-null-assertion', '@typescript-eslint/restrict-template-expressions']));
  expect(await messages('export function label(count: number): string {\n  return `${count} items`;\n}\n')).toEqual([]);
});

test('application tests use type-checked rules without the strict set', async () => {
  const file = 'apps/reHistory/test/unit.test.ts';
  const errors = await messages("export const value: number = JSON.parse('{}').count;\n", file);
  expect(errors.map((error) => error.ruleId)).toContain('@typescript-eslint/no-unsafe-member-access');
  expect(await messages('export function read(map: Map<string, string>): string {\n  return map.get("key")!;\n}\n', file)).toEqual([]);
});

test('strict rules keep runtime checks that static types call unnecessary', async () => {
  const errors = await messages(
    "import { constants } from 'node:fs';\nexport function check(value: { flow: 'dates' }, raw: boolean): number {\n  if (!value || typeof value !== 'object') throw new Error('flow');\n  const enabled = Boolean(raw);\n  return enabled ? (constants.O_NOFOLLOW ?? 0) : 0;\n}\n"
  );
  expect(errors).toEqual([]);
});
