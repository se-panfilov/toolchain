import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_') && !key.toUpperCase().startsWith('GITLEAKS_')));
const gitNullConfig = process.platform === 'win32' ? 'nul' : devNull;
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitNullConfig, GIT_CONFIG_GLOBAL: gitNullConfig, GIT_OPTIONAL_LOCKS: '0' });
// Construct a synthetic token at runtime. Never store a usable credential in source.
const secret = ['gh', 'p_', 'm7K2p9Z4v6B8n3X5q1R0s2T4u6V8w9Y1a3C5'].join('');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-gitleaks-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  for (const path of [
    'scripts/scan-secrets.mjs',
    'scripts/format-changed.mjs',
    'scripts/install-hooks.mjs',
    'scripts/git-rules.mjs',
    'scripts/ci/rules.mjs',
    'scripts/ci/files.mjs',
    '.gitleaks.toml',
    'lefthook.yml'
  ]) {
    if (existsSync(join(workspace, path))) copyFileSync(join(workspace, path), join(root, path));
  }
  symlinkSync(join(workspace, 'node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, '.prettierignore'), 'node_modules/**\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module', scripts: { 'pretty-quick': 'node scripts/format-changed.mjs --staged', 'gitleaks:staged': 'node scripts/scan-secrets.mjs staged' } })
  );
  function git(args, extraEnv = {}) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, 'Synthetic Git operation failed.');
    return result.stdout;
  }
  git(['init', '-q', '--template=', '--initial-branch=fixture']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['-c', 'commit.gpgSign=false', 'commit', '-q', '--allow-empty', '-m', 'Fixture']);
  function scan(mode, extraEnv = {}) {
    return spawnSync(process.execPath, [join(root, 'scripts/scan-secrets.mjs'), mode], { cwd: tmpdir(), env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20000 });
  }
  function command(script, args = []) {
    return spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  }
  return { root, git, scan, command };
}

test('the staged check finds a secret in the index and does not show its bytes', (t) => {
  const { root, git, scan } = fixture(t);
  writeFileSync(join(root, 'space name.txt'), secret + '\n');
  git(['add', '--', 'space name.txt']);
  writeFileSync(join(root, 'space name.txt'), 'clean working copy\n');
  const index = readFileSync(join(root, '.git/index'));
  const result = scan('staged');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /github-pat/);
  assert(!(result.stdout + result.stderr).includes(secret));
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  assert.equal(readFileSync(join(root, 'space name.txt'), 'utf8'), 'clean working copy\n');
});

test('a temporary Git index is checked instead of the usual index', (t) => {
  const { root, git, scan } = fixture(t);
  const alternate = join(root, '.git/alternate-index');
  git(['read-tree', 'HEAD'], { GIT_INDEX_FILE: alternate });
  writeFileSync(join(root, 'data.txt'), secret + '\n');
  git(['add', '--', 'data.txt'], { GIT_INDEX_FILE: alternate });
  const original = existsSync(join(root, '.git/index')) ? readFileSync(join(root, '.git/index')) : undefined;
  const before = readFileSync(alternate);
  const result = scan('staged', { GIT_INDEX_FILE: alternate, GIT_DIR: join(root, 'missing.git') });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /github-pat/);
  assert.deepEqual(readFileSync(alternate), before);
  assert.equal(existsSync(join(root, '.git/index')), original !== undefined);
});

test('inline allow and a user config do not disable the check', (t) => {
  const { root, git, scan } = fixture(t);
  writeFileSync(join(root, 'data.txt'), secret + ' # gitleaks:allow\n');
  git(['add', '--', 'data.txt']);
  const result = scan('staged', { GITLEAKS_CONFIG_TOML: 'title="empty"' });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /github-pat/);
});

test('a Prettier error in the pre-commit check does not print a secret from the source', (t) => {
  const { root, git, command } = fixture(t);
  writeFileSync(join(root, 'broken.ts'), `export const token = "${secret}";\n@@@\n`);
  git(['add', '--', 'broken.ts']);
  const result = command('scripts/format-changed.mjs', ['--staged', '--check']);
  assert.equal(result.status, 1);
  assert(!(result.stdout + result.stderr).includes(secret), 'Formatter diagnostics exposed source content.');
});

test('the installer does not write through a link to the hooks directory', (t) => {
  const { root, command } = fixture(t);
  const external = join(root, 'external-hooks');
  mkdirSync(external);
  rmSync(join(root, '.git/hooks'), { recursive: true, force: true });
  symlinkSync(external, join(root, '.git/hooks'), 'junction');
  const result = command('scripts/install-hooks.mjs');
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(external, 'pre-commit')), false);
});

test('an existing user hook and core.hooksPath are preserved', (t) => {
  const { root, git, command } = fixture(t);
  mkdirSync(join(root, '.git/hooks'), { recursive: true });
  const hook = join(root, '.git/hooks/pre-commit');
  const content = '#!/bin/sh\nexit 0\n';
  writeFileSync(hook, content, { mode: 0o755 });
  assert.equal(command('scripts/install-hooks.mjs').status, 1);
  assert.equal(readFileSync(hook, 'utf8'), content);
  rmSync(hook);
  git(['config', 'core.hooksPath', 'custom-hooks']);
  assert.equal(command('scripts/install-hooks.mjs').status, 1);
  assert.equal(git(['config', '--local', '--get', 'core.hooksPath']).trim(), 'custom-hooks');
  assert.equal(existsSync(hook), false);
});

test('an explicitly empty core.hooksPath is also preserved without installation', (t) => {
  const { root, git, command } = fixture(t);
  git(['config', 'core.hooksPath', '']);
  const configuration = readFileSync(join(root, '.git/config'));
  const result = command('scripts/install-hooks.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core.hooksPath/);
  assert.deepEqual(readFileSync(join(root, '.git/config')), configuration);
  assert.equal(existsSync(join(root, '.git/hooks/pre-commit')), false);
});

test('a Git clean filter does not run before the scan', (t) => {
  const { root, git, scan } = fixture(t);
  const marker = join(root, 'executed');
  const filter = join(root, 'filter.cjs');
  writeFileSync(filter, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe');\n`);
  writeFileSync(join(root, '.gitattributes'), 'data.txt filter=fixture\n');
  writeFileSync(join(root, 'data.txt'), secret + '\n');
  git(['add', '--', 'data.txt']);
  const quote = (value) => '"' + value.replace(/\\/g, '/') + '"';
  git(['config', 'filter.fixture.clean', `${quote(process.execPath)} ${quote(filter)}`]);
  const result = scan('staged');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Git-фильтры/);
  assert.equal(existsSync(marker), false);
});

test('textconv does not run and does not replace a secret with clean text', (t) => {
  const { root, git, scan } = fixture(t);
  const marker = join(root, 'executed');
  const driver = join(root, 'driver.cjs');
  writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'); process.stdout.write('clean');\n`);
  writeFileSync(join(root, '.gitattributes'), 'data.txt diff=fixture\n');
  writeFileSync(join(root, 'data.txt'), secret + '\n');
  git(['add', '--', 'data.txt']);
  const quote = (value) => '"' + value.replace(/\\/g, '/') + '"';
  git(['config', 'diff.fixture.textconv', `${quote(process.execPath)} ${quote(driver)}`]);
  const result = scan('staged');
  assert.equal(result.status, 2);
  assert.equal(existsSync(marker), false);
  git(['config', '--unset', 'diff.fixture.textconv']);
  assert.equal(scan('staged').status, 1);
});

test('a real pre-commit accepts clean code and blocks a secret without a change to the index', (t) => {
  const { root, git, command } = fixture(t);
  const configuration = readFileSync(join(root, '.git/config'));
  const installed = command('scripts/install-hooks.mjs');
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(readFileSync(join(root, '.git/config')), configuration);
  writeFileSync(join(root, 'space name.ts'), 'export const value = 1;\n');
  git(['add', '--', 'space name.ts']);
  function commit(args = []) {
    return spawnSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'Fixture', ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  }
  assert.equal(commit().status, 0);
  writeFileSync(join(root, 'secret.txt'), secret + '\n');
  git(['add', '--', 'secret.txt']);
  const index = git(['ls-files', '--stage', '-z']);
  const result = commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /github-pat/);
  assert(!(result.stdout + result.stderr).includes(secret));
  // Git itself can refresh index cache data before invoking pre-commit.
  assert.equal(git(['ls-files', '--stage', '-z']), index);
  git(['reset', '-q', 'HEAD', '--', 'secret.txt']);
  writeFileSync(join(root, 'space name.ts'), 'export const value={a:1}\n');
  const only = commit(['--only', '--', 'space name.ts']);
  assert.notEqual(only.status, 0, 'Temporary-index formatting check did not block the commit.');
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), '');
  assert.equal(readFileSync(join(root, 'space name.ts'), 'utf8'), 'export const value={a:1}\n');
  writeFileSync(join(root, 'space name.ts'), 'export const value = 1;\n');
  for (const hook of ['commit-msg', 'pre-push']) assert(existsSync(join(root, '.git/hooks', hook)), `${hook} is not installed.`);
  const again = command('scripts/install-hooks.mjs');
  assert.equal(again.status, 0, 'The installer did not replace its own wrapper.');
  const session = commit(['--allow-empty', '-m', 'Claude-Session: https://claude.ai/code/session_1']);
  assert.notEqual(session.status, 0, 'commit-msg accepted an agent session trailer.');
  assert.match(session.stdout + session.stderr, /сессией агента/);
  git(['checkout', '-q', '-b', 'master']);
  writeFileSync(join(root, 'other.ts'), 'export const other = 2;\n');
  git(['add', '--', 'other.ts']);
  const protectedCommit = commit();
  assert.notEqual(protectedCommit.status, 0, 'pre-commit accepted a commit on master.');
  assert.match(protectedCommit.stdout + protectedCommit.stderr, /master запрещён/);
});

test('a shallow history and an unknown mode do not give a false success', (t) => {
  const { root, git, scan } = fixture(t);
  writeFileSync(join(root, '.git/shallow'), git(['rev-parse', 'HEAD']));
  const shallow = scan('history');
  assert.equal(shallow.status, 2);
  assert.match(shallow.stderr, /полный клон/);
  assert.equal(scan('unknown').status, 2);
});

test('a clean index is not blocked by a secret that is only in the working tree', (t) => {
  const { root, git, scan } = fixture(t);
  writeFileSync(join(root, 'data.txt'), 'clean\n');
  git(['add', '--', 'data.txt']);
  writeFileSync(join(root, 'data.txt'), secret + '\n');
  const result = scan('staged');
  assert.equal(result.status, 0, result.stderr);
});

test('the history check finds a deleted secret and another local branch', (t) => {
  const { root, git, scan } = fixture(t);
  git(['checkout', '-q', '-b', 'other']);
  writeFileSync(join(root, 'data.txt'), secret + '\n');
  git(['add', '--', 'data.txt']);
  git(['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'Synthetic fixture']);
  git(['rm', '-q', 'data.txt']);
  git(['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'Remove fixture']);
  git(['checkout', '-q', 'fixture']);
  const result = scan('history');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /github-pat/);
  assert(!(result.stdout + result.stderr).includes(secret));
});

test('the files check includes untracked and ignored source files', (t) => {
  const { root, scan } = fixture(t);
  writeFileSync(join(root, '.gitignore'), 'private.txt\n');
  writeFileSync(join(root, 'private.txt'), secret + '\n');
  const result = scan('files');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /github-pat/);
  assert(!(result.stdout + result.stderr).includes(secret));
});
