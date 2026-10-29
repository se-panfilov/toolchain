import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync, linkSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const modules = ['engine', 'audit', 'export', 'demo', 'prompts', 'cli', 'engine.test', 'features.test', 'prompts.test'];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tx-rehistory-compiler-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ['build.mjs', 'tsconfig.json', ...modules.map(name => `${name}.ts`)]) copyFileSync(join(root, file), join(directory, file));
  writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction');
  return directory;
}
function build(directory) {
  return spawnSync(process.execPath, [join(directory, 'build.mjs')], { cwd: directory, encoding: 'utf8', timeout: 60000 });
}

test('ошибка типов сохраняет dist и не позволяет npm start запустить старую сборку', t => {
  const directory = fixture(t);
  const marker = join(directory, 'unexpected-start');
  mkdirSync(join(directory, 'dist'));
  const stale = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');\n`;
  writeFileSync(join(directory, 'dist', 'cli.js'), stale);
  writeFileSync(join(directory, 'cli.ts'), '\nconst compilationMustFail: string = 1;\n', { flag: 'a' });
  // Keep npm configuration and logs isolated from account settings.
  const userConfig = join(directory, 'user.npmrc');
  const globalConfig = join(directory, 'global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('NPM_CONFIG_')));
  Object.assign(env, { NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: join(directory, 'cache'), NPM_CONFIG_OFFLINE: 'true' });
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, 'start', '--', '--help'], { cwd: directory, env, encoding: 'utf8', timeout: 60000 })
    : spawnSync('npm', ['start', '--', '--help'], { cwd: directory, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /TS2322/);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(directory, 'dist', 'cli.js'), 'utf8'), stale);
});

test('сборка отклоняет ссылки в dist и сохраняет внешние файлы', t => {
  const directory = fixture(t);
  const external = join(directory, 'external.js');
  writeFileSync(external, 'protected');
  const out = join(directory, 'dist');
  const externalDirectory = join(directory, 'external');
  mkdirSync(externalDirectory);
  symlinkSync(externalDirectory, out, 'junction');
  const linkedDirectory = build(directory);
  assert.equal(linkedDirectory.error, undefined);
  assert.notEqual(linkedDirectory.status, 0);
  assert.match(linkedDirectory.stderr, /dist должен/);
  unlinkSync(out);
  mkdirSync(out);
  const destination = join(out, 'cli.js');
  for (const makeLink of [() => symlinkSync(external, destination), () => linkSync(external, destination)]) {
    makeLink();
    const result = build(directory);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Файл сборки/);
    assert.equal(readFileSync(external, 'utf8'), 'protected');
    rmSync(destination);
  }
});
