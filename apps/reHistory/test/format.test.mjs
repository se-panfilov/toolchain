import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(workspace, 'scripts/format-changed.mjs');
const metadata = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_') && !key.toUpperCase().startsWith('NPM_CONFIG_')));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: '0' });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-format-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  mkdirSync(repository);
  mkdirSync(join(repository, 'scripts'));
  copyFileSync(script, join(repository, 'scripts/format-changed.mjs'));
  symlinkSync(join(workspace, 'node_modules'), join(repository, 'node_modules'), 'junction');
  writeFileSync(join(repository, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repository, '.prettierignore'), 'node_modules/**\nignored/**\n');
  writeFileSync(join(repository, '.prettierrc.json'), JSON.stringify({ semi: true, singleQuote: true }));
  function git(args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { cwd: repository, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  git(['init', '-q', '--template=', '--initial-branch=fixture']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  function commit() {
    git(['add', '--all']);
    git(['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'Fixture']);
  }
  function run(args = [], extraEnv = {}) {
    return spawnSync(process.execPath, [join(repository, 'scripts/format-changed.mjs'), ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 });
  }
  return { root, repository, git, commit, run };
}

test('форматирование сохраняет пробелы, переводы строк, glob-символы и имена, похожие на флаги', (t) => {
  const { root, repository, commit, run } = fixture(t);
  const names = ['space name.ts', 'literal[1].mjs', '--config=evil.mjs', ...(process.platform === 'win32' ? [] : ['line\nbreak.ts'])];
  for (const name of names) writeFileSync(join(repository, name), 'export const value = 1;\n');
  commit();
  for (const name of names) writeFileSync(join(repository, name), 'export const value={a:1}\n');
  const marker = join(root, 'executed');
  writeFileSync(join(repository, 'evil.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); export default {};`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of names) assert.equal(readFileSync(join(repository, name), 'utf8'), 'export const value = { a: 1 };\n');
  assert.equal(existsSync(marker), false);
  assert(!result.stdout.includes('line\nbreak.ts'));
});

test('staged-режим форматирует выбранные файлы без изменения индекса', (t) => {
  const { repository, git, commit, run } = fixture(t);
  writeFileSync(join(repository, 'chosen.ts'), 'export const value = 1;\n');
  writeFileSync(join(repository, 'other.ts'), 'export const value = 1;\n');
  commit();
  const unformatted = 'export const value={a:1}\n';
  writeFileSync(join(repository, 'chosen.ts'), unformatted);
  git(['add', '--', 'chosen.ts']);
  writeFileSync(join(repository, 'other.ts'), unformatted);
  const index = readFileSync(join(repository, '.git/index'));
  const result = run(['--staged']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(repository, 'chosen.ts'), 'utf8'), 'export const value = { a: 1 };\n');
  assert.equal(readFileSync(join(repository, 'other.ts'), 'utf8'), unformatted);
  assert.deepEqual(readFileSync(join(repository, '.git/index')), index);
});

test('частично staged-файл отклоняется до любых записей', (t) => {
  const { repository, git, commit, run } = fixture(t);
  writeFileSync(join(repository, 'a.ts'), 'export const value = 1;\n');
  writeFileSync(join(repository, 'b.ts'), 'export const value = 1;\n');
  commit();
  const unformatted = 'export const value={a:1}\n';
  for (const name of ['a.ts', 'b.ts']) writeFileSync(join(repository, name), unformatted);
  git(['add', '--', 'a.ts', 'b.ts']);
  writeFileSync(join(repository, 'b.ts'), 'export const value={a:2}\n');
  const index = readFileSync(join(repository, '.git/index'));
  const result = run(['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged- и unstaged/);
  assert.equal(readFileSync(join(repository, 'a.ts'), 'utf8'), unformatted);
  assert.equal(readFileSync(join(repository, 'b.ts'), 'utf8'), 'export const value={a:2}\n');
  assert.deepEqual(readFileSync(join(repository, '.git/index')), index);
});

test('форматирование учитывает ignore-файл и удаляет Git-переменные выбора цели', (t) => {
  const { root, repository, commit, run } = fixture(t);
  mkdirSync(join(repository, 'ignored'));
  writeFileSync(join(repository, 'chosen.ts'), 'export const value = 1;\n');
  writeFileSync(join(repository, 'ignored/fixture.ts'), 'export const value = 1;\n');
  commit();
  const unformatted = 'export const value={a:1}\n';
  for (const name of ['chosen.ts', 'ignored/fixture.ts']) writeFileSync(join(repository, name), unformatted);
  const result = run([], { GIT_DIR: join(root, 'missing.git'), git_work_tree: root, Git_Index_File: join(root, 'missing-index') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(repository, 'chosen.ts'), 'utf8'), 'export const value = { a: 1 };\n');
  assert.equal(readFileSync(join(repository, 'ignored/fixture.ts'), 'utf8'), unformatted);
});

test('Git clean-фильтр отклоняется до diff и не запускает внешний код', (t) => {
  const { root, repository, git, commit, run } = fixture(t);
  writeFileSync(join(repository, '.gitattributes'), 'chosen.ts filter=fixture\n');
  writeFileSync(join(repository, 'chosen.ts'), 'export const value = 1;\n');
  commit();
  const marker = join(root, 'executed');
  const filter = join(root, 'filter.cjs');
  writeFileSync(filter, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'); process.stdout.write(require('node:fs').readFileSync(0));\n`);
  // Git parses this command. Quote fixture paths for its shell on each platform.
  const quote = (value) => '"' + value.replace(/\\/g, '/') + '"';
  git(['config', 'filter.fixture.clean', `${quote(process.execPath)} ${quote(filter)}`]);
  const bytes = 'export const value={a:1}\n';
  writeFileSync(join(repository, 'chosen.ts'), bytes);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git-фильтры не поддерживаются/);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(repository, 'chosen.ts'), 'utf8'), bytes);
});

for (const kind of ['symlink', 'hardlink']) {
  test.skipIf(kind === 'symlink' && process.platform === 'win32')(`форматирование отклоняет ${kind} и сохраняет внешние данные`, (t) => {
    const { root, repository, commit, run } = fixture(t);
    const file = join(repository, 'chosen.ts');
    writeFileSync(file, 'export const value = 1;\n');
    commit();
    const external = join(root, 'external.ts');
    const bytes = 'export const value={a:1}\n';
    writeFileSync(external, bytes);
    rmSync(file);
    if (kind === 'symlink') symlinkSync(external, file);
    else linkSync(external, file);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /обычный файл без ссылок/);
    assert.equal(readFileSync(external, 'utf8'), bytes);
  });
}

test.skipIf(process.platform !== 'linux')('невалидный UTF-8 в имени отклоняется без выбора другого файла на Linux', (t) => {
  const { repository, git, commit, run } = fixture(t);
  const name = Buffer.concat([Buffer.from(repository + '/'), Buffer.from([255]), Buffer.from('.ts')]);
  writeFileSync(name, 'export const value = 1;\n');
  commit();
  writeFileSync(name, 'export const value={a:1}\n');
  git(['add', '--all']);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UTF-8/);
  assert.equal(readFileSync(name, 'utf8'), 'export const value={a:1}\n');
});

test('пустой выбор и неизвестные параметры не запускают форматирование', (t) => {
  const { commit, run } = fixture(t);
  commit();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /файлов для форматирования нет/);
  const invalid = run(['--unknown']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Допустимы параметры/);
});

test('check-режим не пишет файлы и возвращает ошибку для неверного формата', (t) => {
  const { repository, git, commit, run } = fixture(t);
  writeFileSync(join(repository, 'chosen.ts'), 'export const value = 1;\n');
  commit();
  const unformatted = 'export const value={a:1}\n';
  writeFileSync(join(repository, 'chosen.ts'), unformatted);
  git(['add', '--', 'chosen.ts']);
  const index = readFileSync(join(repository, '.git/index'));
  const result = run(['--staged', '--check']);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(repository, 'chosen.ts'), 'utf8'), unformatted);
  assert.deepEqual(readFileSync(join(repository, '.git/index')), index);
  assert.equal(run(['--check', '--check']).status, 1);
});

test('ссылка в родительском каталоге отклоняется до форматирования staged-файла', (t) => {
  const { root, repository, git, commit, run } = fixture(t);
  mkdirSync(join(repository, 'nested'));
  writeFileSync(join(repository, 'nested/chosen.ts'), 'export const value = 1;\n');
  commit();
  const bytes = 'export const value={a:1}\n';
  writeFileSync(join(repository, 'nested/chosen.ts'), bytes);
  git(['add', '--', 'nested/chosen.ts']);
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'chosen.ts'), bytes);
  rmSync(join(repository, 'nested'), { recursive: true });
  symlinkSync(external, join(repository, 'nested'), 'junction');
  const result = run(['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /обычный файл без ссылок/);
  assert.equal(readFileSync(join(external, 'chosen.ts'), 'utf8'), bytes);
});

test('clean:reinstall выполняет offline npm ci без lifecycle-скриптов', (t) => {
  // This fixture has no dependency links. npm ci can remove only its own node_modules.
  const directory = mkdtempSync(join(tmpdir(), 'toolchain-reinstall-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { 'clean:reinstall': metadata.scripts['clean:reinstall'], postinstall: 'node postinstall.cjs' } })
  );
  writeFileSync(
    join(directory, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0', hasInstallScript: true } } })
  );
  writeFileSync(join(directory, 'postinstall.cjs'), "require('node:fs').writeFileSync('executed', 'unsafe');\n");
  const config = { NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_USERCONFIG: devNull, NPM_CONFIG_GLOBALCONFIG: join(directory, 'global.npmrc'), NPM_CONFIG_CACHE: join(directory, 'cache') };
  writeFileSync(config.NPM_CONFIG_GLOBALCONFIG, '');
  const result = spawnSync('npm', ['run', 'clean:reinstall', '--', '--offline', '--no-audit', '--no-fund'], { cwd: directory, env: { ...env, ...config }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(directory, 'executed')), false);
});
