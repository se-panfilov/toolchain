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

test('конфигурация проверяет типы spread, возвращаемые типы и type-export', async () => {
  const errors = await messages('type Item = string;\nexport { Item };\nexport function result() { return { ...[1, 2] }; }\n');
  expect(errors.map((error) => error.ruleId)).toEqual(
    expect.arrayContaining(['@typescript-eslint/no-misused-spread', '@typescript-eslint/explicit-function-return-type', '@typescript-eslint/consistent-type-exports'])
  );
});

test('type-import, сортировка и запрет собственного npm-импорта действуют вместе', async () => {
  const errors = await messages(
    "import { Repository } from '@reHistory/engine';\nimport { readFileSync } from 'node:fs';\nimport 'tx-rehistory';\nexport const read = readFileSync;\nexport type Repo = Repository;\n"
  );
  expect(errors.map((error) => error.ruleId)).toEqual(expect.arrayContaining(['@typescript-eslint/consistent-type-imports', 'simple-import-sort/imports', 'no-restricted-imports']));
});

test('runtime-модули требуют alias, а тестовые фикстуры допускают относительные импорты', async () => {
  const code = "import './fixture.js';\n";
  expect((await messages(code)).map((error) => error.ruleId)).toContain('no-restricted-imports');
  expect(await messages(code, 'apps/reHistory/test/unit.test.ts')).toEqual([]);
});

test('Node.js не получает браузерные глобальные переменные', async () => {
  const errors = await messages('window.alert("unsafe");\n', 'configs/lint-fixture.mjs');
  expect(errors.map((error) => error.ruleId)).toContain('no-undef');
});

test('ограничения setter, arguments и Object.assign действуют без отдельного плагина', async () => {
  const errors = await messages(
    "export const value = { set field(value) { console.log(value); } };\nexport function read() { return arguments[0]; }\nObject.assign({}, {a: 1}, {b: 2});\nObject['assign']({}, {a: 1}, {b: 2});\n",
    'configs/lint-fixture.mjs'
  );
  expect(errors.filter((error) => error.ruleId === 'no-restricted-syntax')).toHaveLength(4);
});

test('CLI допускает мутации, getter сигнала, rest-параметры и русский текст', async () => {
  const errors = await messages(
    "export function status(...values: string[]): { readonly interrupted: boolean } {\nconst state = { interrupted: false };\nvalues.push('Ввод отменён.');\nObject.assign(state, { interrupted: true });\nreturn { get interrupted(): boolean { return state.interrupted; } };\n}\n"
  );
  expect(errors).toEqual([]);
  expect(await messages('export const value: { arguments: string[] } = { arguments: [] };\nvalue.arguments.push("значение");\n')).toEqual([]);
});

test('исключения не скрывают any, неиспользуемые переменные и смешанные возвраты', async () => {
  const errors = await messages('export function read(value: any): unknown { const unused = 1; if (value) return value; return; }\n');
  expect(errors.map((error) => error.ruleId)).toEqual(expect.arrayContaining(['@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unused-vars', 'consistent-return']));
});

test('конфигурация работает из каталога приложения и не требует типов для служебных JS-файлов', async () => {
  const local = new ESLint({ cwd: fileURLToPath(new URL('../', import.meta.url)) });
  const [result] = await local.lintText('export const value: number = 1;\n', { filePath: 'src/engine.ts' });
  expect(result.messages).toEqual([]);
  expect(await messages('export const value = process.platform;\n', 'configs/lint-fixture.mjs')).toEqual([]);
  expect(await messages('export const value: number = 1;\n', 'tests/skills/skill-scanner.test.ts')).toEqual([]);
});

test('генерируемые файлы и vendored skills остаются вне ESLint', async () => {
  for (const path of ['apps/reHistory/dist/src/cli.js', 'node_modules/fixture/index.js', '.agents/skills/fixture/index.ts', 'coverage/index.js', 'reports/index.js']) {
    expect(await eslint.isPathIgnored(fileURLToPath(new URL(path, new URL('../../../', import.meta.url))))).toBe(true);
  }
  const config = await eslint.calculateConfigForFile(source);
  expect(Object.keys(config.plugins)).toEqual(expect.arrayContaining(['@typescript-eslint', 'simple-import-sort']));
  expect(Object.keys(config.plugins)).not.toContain('spellcheck');
});
