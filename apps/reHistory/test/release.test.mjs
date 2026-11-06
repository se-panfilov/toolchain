import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rehistory-release-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/publish.mjs', import.meta.url), join(root, 'scripts/publish.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const archive = join(root, 'tx-rehistory-1.2.3.tgz');
  writeFileSync(archive, 'original packed bytes');
  const marker = join(root, 'published.json');
  const npm = join(root, 'npm-fixture.mjs');
  writeFileSync(
    npm,
    `import { writeFileSync, readFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), bytes: readFileSync(process.argv[3], 'utf8') }));
    process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);`
  );
  const run = (args = [], env = {}) =>
    spawnSync(process.execPath, [join(root, 'scripts/publish.mjs'), ...args], {
      cwd: tmpdir(),
      // Windows environment variable names are case-insensitive. Remove every inherited spelling.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NPM_EXECPATH')), npm_execpath: npm, ...env },
      encoding: 'utf8',
      timeout: 30000
    });
  return { root, archive, marker, run };
}

test('release передаёт npm исходный архив, правильный cwd и флаги dry-run', (t) => {
  const { root, marker, run } = fixture(t);
  const result = run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const publication = JSON.parse(readFileSync(marker, 'utf8'));
  assert.deepEqual(publication.args, ['publish', './tx-rehistory-1.2.3.tgz', '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--access=public', '--dry-run']);
  assert.equal(realpathSync(publication.cwd), realpathSync(root));
  assert.equal(publication.bytes, 'original packed bytes');
});

test('release возвращает ошибку npm без повторной публикации', (t) => {
  const { run } = fixture(t);
  assert.equal(run([], { FIXTURE_EXIT_CODE: '7' }).status, 7);
});

test('release не принимает флаги выбора других пакетов', (t) => {
  const { marker, run } = fixture(t);
  const result = run(['--workspaces']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(marker), false);
});

test('release останавливается при отсутствии архива или при ссылках', (t) => {
  const { root, archive, marker, run } = fixture(t);
  rmSync(archive);
  assert.notEqual(run().status, 0);
  const target = join(root, 'external.tgz');
  writeFileSync(target, 'protected');
  symlinkSync(target, archive);
  assert.notEqual(run().status, 0);
  rmSync(archive);
  linkSync(target, archive);
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(target, 'utf8'), 'protected');
});
