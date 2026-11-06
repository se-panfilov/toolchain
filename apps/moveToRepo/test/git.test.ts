import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SourceFile } from '@moveToRepo/files';
import { Clone, commitMessage, gitConfig, parentDirectories, parseTree, pullRequestTitle, pushArguments } from '@moveToRepo/git';
import { findExecutable, runTool, toolEnvironment } from '@moveToRepo/tools';
import { describe, expect, test, type TestContext, vi } from 'vitest';

// moveToRepo supports only macOS and Linux. On Windows, only the CLI platform check is tested.
const posix = process.platform !== 'win32';
const gitPath = posix ? findExecutable('git') : '';

// Plain Git for fixture setup only. The tested code uses its own isolated environment.
function git(cwd: string, args: string[]): string {
  const result = spawnSync(gitPath, ['-c', 'protocol.file.allow=always', ...args], { cwd, env: toolEnvironment(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

type Fixture = { root: string; clone: Clone; bare: string };

/** A bare repository with one commit, and a no-checkout clone of it, as Clone.clone makes it. */
function fixture(context: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'movetorepo-git-'));
  context.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', '');
  const source = join(root, 'source');
  mkdirSync(join(source, 'to-A'), { recursive: true });
  mkdirSync(join(source, 'sub'));
  writeFileSync(join(source, 'to-A/some1.txt'), 'old');
  writeFileSync(join(source, 'to-A/same.txt'), 'same');
  writeFileSync(join(source, 'file'), 'a file');
  writeFileSync(join(source, 'sub/keep.txt'), 'keep');
  git(root, ['init', '--quiet', source]);
  git(source, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(source, ['add', '.']);
  git(source, ['-c', 'core.symlinks=true', 'commit', '--quiet', '-m', 'init']);
  const bare = join(root, 'bare.git');
  git(root, ['clone', '--quiet', '--bare', source, bare]);
  const work = join(root, 'work');
  mkdirSync(work);
  const clone = new Clone(gitPath, '/usr/bin/true', work);
  git(root, ['clone', '--quiet', '--no-checkout', '--depth', '1', `file://${bare}`, clone.path]);
  clone.run(['read-tree', 'HEAD']);
  return { root, clone, bare };
}

function file(target: string, content: string, executable = false): SourceFile {
  return { source: target, target, content: Buffer.from(content), executable };
}

describe('environment and settings', () => {
  test('Git routing and gh target variables are removed, authentication stays', () => {
    const env = toolEnvironment({
      PATH: '/bin',
      GIT_DIR: '/x',
      git_work_tree: '/y',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'",
      GH_REPO: 'a/b',
      gh_host: 'evil.example',
      GH_TOKEN: 't',
      GIT_SSH_COMMAND: 'ssh -i k',
      HOME: '/h'
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.git_work_tree).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GH_REPO).toBeUndefined();
    expect(env.gh_host).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/bin', GH_TOKEN: 't', GIT_SSH_COMMAND: 'ssh -i k', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
  });

  test('settings disable hooks and limit transports to HTTPS and SSH', () => {
    const config = gitConfig('/usr/local/bin/gh', '/tmp/hooks');
    expect(config).toContain('core.hooksPath=/tmp/hooks');
    expect(config).toContain('protocol.allow=never');
    expect(config).toContain('credential.helper=');
    expect(config).toContain('credential.helper=!/usr/local/bin/gh auth git-credential');
    expect(config.indexOf('credential.helper=')).toBeLessThan(config.indexOf('credential.helper=!/usr/local/bin/gh auth git-credential'));
  });

  test.skipIf(!posix)('a timeout is reported as a timeout, not as an interruption', () => {
    expect(() => runTool(findExecutable('sleep'), ['5'], { cwd: tmpdir(), timeout: 200 }, 'sleep')).toThrow('sleep: превышено время ожидания.');
  });

  test('push never forces', () => {
    const args = pushArguments('https://github.com/me/notes.git', 'a'.repeat(40), 'movetorepo/ab12cd34');
    expect(args.some((arg) => arg.startsWith('+') || arg.startsWith('--force') || arg === '-f')).toBe(false);
    expect(args.at(-1)).toBe(`${'a'.repeat(40)}:refs/heads/movetorepo/ab12cd34`);
    expect(() => pushArguments('u', '+abc', 'b')).toThrow(/ID коммита/);
  });

  test.each(['main', 'master', 'movetorepo/main', 'movetorepo/ab12cd34/x', 'movetorepo/AB12CD34', 'refs/heads/main', 'x/movetorepo/ab12cd34'])('push to %j is rejected', (branch) => {
    expect(() => pushArguments('https://github.com/me/notes.git', 'a'.repeat(40), branch)).toThrow(/только в новую ветку/);
  });
});

describe('helpers', () => {
  test('tree output and parent directories', () => {
    expect(parseTree(`100644 blob ${'a'.repeat(40)}\ta b.txt\u0000040000 tree ${'b'.repeat(40)}\tdir\0`)).toEqual(
      new Map([
        ['a b.txt', { mode: '100644', type: 'blob', oid: 'a'.repeat(40) }],
        ['dir', { mode: '040000', type: 'tree', oid: 'b'.repeat(40) }]
      ])
    );
    expect(() => parseTree('garbage\0')).toThrow(/некорректный/);
    expect(parentDirectories(['a/b/c.txt', 'a/d.txt', 'e.txt'])).toEqual(['a', 'a/b']);
  });

  test('message and title list the files', () => {
    const changes = [
      { ...file('to-A/some1.txt', ''), mode: '100644' as const, state: 'add' as const },
      { ...file('to-B/some4.txt', ''), mode: '100644' as const, state: 'replace' as const }
    ];
    expect(commitMessage(changes)).toBe('to-A/some1.txt\nto-B/some4.txt\n');
    expect(pullRequestTitle(changes)).toBe('to-A/some1.txt, to-B/some4.txt');
    expect(pullRequestTitle(Array.from({ length: 20 }, (_, i) => ({ ...file(`dir/file-${i}.txt`, ''), mode: '100644' as const, state: 'add' as const }))).length).toBe(120);
  });
});

describe.skipIf(!posix)('clone, plan, and commit', () => {
  test('a local file URL is blocked by the transport settings', (context) => {
    const { root, bare } = fixture(context);
    const work = join(root, 'blocked');
    mkdirSync(work);
    const clone = new Clone(gitPath, '/usr/bin/true', work);
    expect(() => clone.clone(`file://${bare}`, 'main')).toThrow(/transport 'file' not allowed/);
    expect(() => clone.clone(bare, 'main')).toThrow(/transport 'file' not allowed/);
  });

  test('the plan marks new, replaced, and unchanged files', (context) => {
    const { clone } = fixture(context);
    const plan = clone.plan([file('to-A/some1.txt', 'new'), file('to-A/same.txt', 'same'), file('to-B/some4.txt', 'four'), file('to-A/run.sh', 'x', true)]);
    expect(plan.map((change) => [change.target, change.state, change.mode])).toEqual([
      ['to-A/some1.txt', 'replace', '100644'],
      ['to-A/same.txt', 'same', '100644'],
      ['to-B/some4.txt', 'add', '100644'],
      ['to-A/run.sh', 'add', '100755']
    ]);
  });

  test('a destination that is a directory, or a parent that is a file, stops the run', (context) => {
    const { clone } = fixture(context);
    expect(() => clone.plan([file('sub', 'x')])).toThrow(/не обычный файл/);
    expect(() => clone.plan([file('file/x.txt', 'x')])).toThrow(/не каталог/);
  });

  test('the commit changes only the listed files and keeps the others', (context) => {
    const { clone } = fixture(context);
    vi.stubEnv('GIT_DIR', '/nonexistent');
    vi.stubEnv('GIT_INDEX_FILE', '/nonexistent/index');
    const changes = clone.plan([file('to-A/some1.txt', 'new'), file('to-B/some4.txt', 'four')]);
    const commit = clone.commit(changes);
    expect(clone.run(['show', `${commit}:to-A/some1.txt`])).toBe('new');
    expect(clone.run(['show', `${commit}:to-B/some4.txt`])).toBe('four');
    expect(clone.run(['show', `${commit}:sub/keep.txt`])).toBe('keep');
    expect(clone.run(['log', '-1', '--format=%B', commit])).toBe('to-A/some1.txt\nto-B/some4.txt\n\n');
    expect(clone.run(['rev-parse', `${commit}^`]).trim()).toBe(clone.run(['rev-parse', 'HEAD']).trim());
    expect(clone.run(['rev-parse', 'refs/heads/main']).trim()).toBe(clone.run(['rev-parse', 'HEAD']).trim());
  });

  test('Cyrillic paths go into the commit without quotes or escapes', (context) => {
    const { clone } = fixture(context);
    const targets = ['export/Младшая Звезда - beta - 0_3_0.html', 'manuscript/Младшая Звезда.md', 'Рукописи/ёж й.txt'];
    const changes = clone.plan(targets.map((target) => file(target, target)));
    expect(changes.map((change) => change.state)).toEqual(['add', 'add', 'add']);
    const commit = clone.commit(changes);
    for (const target of targets) expect(clone.run(['show', `${commit}:${target}`])).toBe(target);
    expect(clone.run(['log', '-1', '--format=%B', commit])).toBe(`${targets.join('\n')}\n\n`);
  });

  // The production settings block the file transport, so these tests push with the fixture Git and the production arguments.
  test('the push creates an absent branch', (context) => {
    const { clone, bare } = fixture(context);
    const commit = clone.commit(clone.plan([file('to-A/some1.txt', 'new')]));
    git(clone.path, pushArguments(bare, commit, 'movetorepo/ab12cd34'));
    expect(git(bare, ['rev-parse', 'refs/heads/movetorepo/ab12cd34']).trim()).toBe(commit);
  });
});
