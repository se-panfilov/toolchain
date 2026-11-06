import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readRegularFile } from '../../scripts/ci/files.mjs';
import { root } from '../../scripts/ci/lib.mjs';
import { aiLinkProblems, branchProblems, changesApplication, isDependabotPullRequest, lockfileChanges, pullRequestBodyProblems, versionProblems, versionStep } from '../../scripts/ci/rules.mjs';
import { commitMessageProblems, pushProblems } from '../../scripts/git-rules.mjs';

const script = join(root, 'scripts', 'git-rules.mjs');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'toolchain-rules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function hook(cwd, args, input = '') {
  return spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', env: gitEnv });
}

test('branch names follow <type>/<short_description>', () => {
  for (const name of ['feature/add_export', 'bugfix/fix_archive_paths', 'docs/update_readme', 'chore/enforce_documented_rules', 'test/x1']) assert.deepEqual(branchProblems(name), [], name);
  for (const name of ['master', 'main', 'claude/project-thread-abc', 'feature/Add_Export', 'feature/add-export', 'feature/', 'feature/add__export', 'fix/x', 'feature/a/b'])
    assert.equal(branchProblems(name).length, 1, name);
});

test('only the Dependabot account with a dependabot/ branch skips the branch and description checks', () => {
  assert.ok(isDependabotPullRequest('dependabot[bot]', 'dependabot/npm_and_yarn/vite-8.3.6'));
  assert.ok(isDependabotPullRequest('dependabot[bot]', 'dependabot/github_actions/github-actions-abc123'));
  for (const [author, branch] of [
    ['se-panfilov', 'dependabot/npm_and_yarn/vite-8.3.6'],
    ['dependabot', 'dependabot/npm_and_yarn/vite-8.3.6'],
    ['Dependabot[bot]', 'dependabot/npm_and_yarn/vite-8.3.6'],
    ['dependabot[bot]', 'feature/x'],
    ['dependabot[bot]', 'xdependabot/npm_and_yarn/vite'],
    ['', '']
  ])
    assert.equal(isDependabotPullRequest(author, branch), false, `${author} ${branch}`);
});

test('agent session links and trailers are rejected, product links are not', () => {
  for (const text of [
    'See https://claude.ai/code/session_01ABC',
    'https://claude.ai/code/project/chan_1?thread=x',
    'https://claude.ai/chat/123',
    'https://chatgpt.com/c/abc',
    'https://chatgpt.com/codex/tasks/task_1',
    'https://chatgpt.com/share/abc',
    'https://gemini.google.com/app/abc',
    'Subject\n\nClaude-Session: https://example.invalid/x',
    'Subject\n\nCodex-Session: 123'
  ]) {
    assert.ok(aiLinkProblems(text, 'Text').length > 0, text);
  }
  for (const text of [
    'Generated with [Claude Code](https://claude.com/claude-code)',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'Use https://claude.ai/code for setup.',
    'The session timeout is 5 minutes.'
  ]) {
    assert.deepEqual(aiLinkProblems(text, 'Text'), [], text);
  }
  assert.ok(!aiLinkProblems('https://chatgpt.com/c/secret-id', 'Text').join('').includes('secret-id'));
  // Host names must match exactly, with or without a scheme.
  for (const text of ['claude.ai/chat/1', 'https://www.chatgpt.com/c/abc', '(https://claude.ai/share/x)']) assert.equal(aiLinkProblems(text, 'Text').length, 1, text);
  for (const text of ['https://notclaude.ai/chat/1', 'https://claude.ai.example.invalid/chat/1', 'https://example.invalid/claude.ai/chat/1']) assert.deepEqual(aiLinkProblems(text, 'Text'), [], text);
});

test('a pull request description starts with tl;dr and has the template sections', () => {
  const sections = '\n\n## Changes\n\nText.\n\n## Verification\n\nText.\n';
  assert.deepEqual(pullRequestBodyProblems(`## tl;dr\n\nПлан на русском: кнопка «Отмена».${sections}`), []);
  assert.deepEqual(pullRequestBodyProblems(`<!-- marker -->\n_Requested by **Light**_\n\n## tl;dr\n\nText.${sections}`), []);
  assert.equal(pullRequestBodyProblems(`Intro text.\n\n## tl;dr\n\nText.${sections}`).length, 1);
  assert.equal(pullRequestBodyProblems(`_One_\n_Two_\n## tl;dr${sections}`).length, 1);
  assert.equal(pullRequestBodyProblems('## tl;dr\n\nText.').length, 2);
  assert.equal(pullRequestBodyProblems('').length, 3);
});

test('application versions change by exactly one step when application files change', () => {
  assert.equal(versionStep('1.2.3', '1.2.3'), 'same');
  assert.equal(versionStep('1.2.3', '1.2.4'), 'patch');
  assert.equal(versionStep('1.2.3', '1.3.0'), 'minor');
  assert.equal(versionStep('1.2.3', '2.0.0'), 'major');
  for (const head of ['1.2.5', '1.3.1', '2.1.0', '1.2.2', '1.2.3-beta.1']) assert.equal(versionStep('1.2.3', head), 'invalid', head);
  assert.ok(changesApplication('demo', 'apps/demo/src/cli.ts'));
  assert.ok(changesApplication('demo', 'apps/demo/README.md'));
  assert.ok(!changesApplication('demo', 'apps/demo/test/cli.test.ts'));
  assert.ok(!changesApplication('demo', 'apps/demoOther/src/cli.ts'));
  const app = { dir: 'demo', name: 'tx-demo', baseVersion: '1.0.0' };
  assert.deepEqual(versionProblems([{ ...app, version: '1.0.0' }], ['apps/demo/test/a.test.ts', 'docs/X.md']), []);
  assert.deepEqual(versionProblems([{ ...app, version: '1.0.1' }], ['apps/demo/src/cli.ts']), []);
  assert.match(versionProblems([{ ...app, version: '1.0.0' }], ['apps/demo/src/cli.ts']).join(''), /npm version patch --workspace tx-demo/);
  assert.match(versionProblems([{ ...app, version: '1.0.2' }], ['apps/demo/src/cli.ts']).join(''), /один шаг/);
  assert.deepEqual(versionProblems([{ ...app, baseVersion: undefined, version: '0.1.0' }], ['apps/demo/src/cli.ts']), []);
});

test('new lockfile packages come from the npm registry with integrity and no unreviewed install script', () => {
  const entry = (version, extra = {}) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: 'sha512-abc', ...extra });
  const base = { packages: { '': {}, 'apps/demo': { version: '1.0.0' }, 'node_modules/kept': entry('1.0.0'), 'node_modules/lefthook': entry('2.2.2', { hasInstallScript: true }) } };
  const head = {
    packages: {
      ...base.packages,
      'node_modules/lefthook': entry('2.3.0', { hasInstallScript: true }),
      'node_modules/fresh': entry('1.0.0'),
      'node_modules/tx-demo': { resolved: 'apps/demo', link: true },
      'node_modules/a/node_modules/hooked': entry('1.0.0', { hasInstallScript: true }),
      'node_modules/remote': { version: '1.0.0', resolved: 'https://example.invalid/remote.tgz', integrity: 'sha1-abc' }
    }
  };
  const { changes, problems } = lockfileChanges(base, head);
  assert.equal(changes.length, 5);
  assert.ok(changes.some((change) => change.includes('lefthook@2.3.0 (было 2.2.2)')));
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /hooked содержит скрипт установки/);
  assert.match(problems.join('\n'), /remote загружается не из/);
  assert.match(problems.join('\n'), /remote нет integrity/);
});

test('pre-push rejects master and main, commit-msg rejects session links', () => {
  assert.deepEqual(pushProblems(`refs/heads/feature/x ${'a'.repeat(40)} refs/heads/feature/x ${'0'.repeat(40)}\n`), []);
  assert.equal(pushProblems(`refs/heads/x ${'a'.repeat(40)} refs/heads/master ${'b'.repeat(40)}\nrefs/heads/x ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`).length, 2);
  assert.deepEqual(pushProblems(`refs/tags/v1 ${'a'.repeat(40)} refs/tags/master ${'0'.repeat(40)}\n`), []);
  assert.deepEqual(commitMessageProblems('Add a check\n\n# https://claude.ai/code/session_1 in a Git comment line\n'), []);
  assert.equal(commitMessageProblems('Add a check\n\nClaude-Session: https://claude.ai/code/session_1\n').length, 2);
});

test('the hook script checks the current branch, a message file, and pre-push input in a real repository', (t) => {
  const repo = temporary(t);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env: gitEnv }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'master');
  assert.equal(hook(repo, ['branch']).status, 1);
  assert.match(hook(repo, ['branch']).stderr, /master запрещён/);
  git('checkout', '-q', '-b', 'feature/add_rules');
  assert.equal(hook(repo, ['branch']).status, 0);
  const message = join(repo, 'MESSAGE');
  writeFileSync(message, 'Add rules\n');
  assert.equal(hook(repo, ['message', message]).status, 0);
  writeFileSync(message, 'Add rules\n\nSee https://chatgpt.com/codex/tasks/task_1\n');
  assert.equal(hook(repo, ['message', message]).status, 1);
  assert.equal(hook(repo, ['push'], `refs/heads/x ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`).status, 1);
  assert.equal(hook(repo, ['push'], `refs/heads/x ${'a'.repeat(40)} refs/heads/feature/add_rules ${'b'.repeat(40)}\n`).status, 0);
  assert.equal(hook(repo, ['unknown']).status, 2);
  assert.equal(hook(repo, ['message']).status, 2);
});

test('a regular file is read through one descriptor, and links and directories are rejected', (t) => {
  const directory = temporary(t);
  const file = join(directory, 'file.txt');
  writeFileSync(file, 'text');
  assert.equal(readRegularFile(file), 'text');
  assert.equal(readRegularFile(join(directory, 'missing.txt')), undefined);
  assert.throws(() => readRegularFile(file, 2), /слишком большой/);
  mkdirSync(join(directory, 'folder'));
  assert.throws(() => readRegularFile(join(directory, 'folder')), /обычный файл/);
  if (process.platform !== 'win32') {
    symlinkSync(file, join(directory, 'link.txt'));
    assert.throws(() => readRegularFile(join(directory, 'link.txt')), /ссылки/);
  }
});
