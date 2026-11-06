import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRuntime, parseArguments } from '@moveToRepo/cli';
import { describe, expect, test, type TestContext } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const repo = 'https://github.com/me/notes';

function run(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'movetorepo-cli-'));
  context.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('help and version work', () => {
  const help = run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('tx-movetorepo --repo URL');
  expect(run(['--version']).stdout.trim()).toBe(manifest.version);
});

test('the built entry point is executable', () => {
  // Read the mode and the contents from one open file descriptor.
  const fd = openSync(cli, 'r');
  try {
    if (process.platform !== 'win32') expect(fstatSync(fd).mode & 0o111).not.toBe(0);
    expect(readFileSync(fd, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  } finally {
    closeSync(fd);
  }
});

test('an unknown option stops before any work', () => {
  const result = run(['--force', '--repo', repo]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Неизвестный параметр: --force');
  expect(result.stdout).toBe('');
});

test('Windows stops with the platform message', () => {
  const result = run(['--repo', repo, '--dest', 'd', 'a.txt']);
  if (process.platform === 'win32') expect(result.stderr).toContain('только macOS и Linux');
  else expect(result.stderr).not.toContain('только macOS и Linux');
});

test.skipIf(process.platform === 'win32')('local file checks stop the run before gh or Git starts', (context) => {
  const root = fixture(context);
  writeFileSync(join(root, 'server.pem'), 'x');
  writeFileSync(join(root, 'notes.txt'), 'x');
  // A fake gh and git record each start. They must never start.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['gh', 'git']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho started > "${join(root, 'started')}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  expect(run(['--repo', repo, '--dest', 'd', 'server.pem'], root, env).stderr).toContain('секретами');
  expect(run(['--repo', repo, '--dest', 'd', 'missing.txt'], root, env).stderr).toContain('Файл не найден');
  expect(run(['--repo', repo, '--dest', 'd', '../notes.txt'], root, env).stderr).toContain('выход из каталога');
  expect(() => statSync(join(root, 'started'))).toThrow();
});

describe('arguments', () => {
  test('Cyrillic files map to their destination directories', () => {
    const args = parseArguments(['--repo', repo, '--dest', 'export', '__build/Младшая Звезда - beta - 0_3_0.docx', '--dest', 'manuscript', 'Манускрипты/Младшая Звезда.md']);
    expect(args.entries).toEqual([
      { source: '__build/Младшая Звезда - beta - 0_3_0.docx', target: 'export/Младшая Звезда - beta - 0_3_0.docx' },
      { source: 'Манускрипты/Младшая Звезда.md', target: 'manuscript/Младшая Звезда.md' }
    ]);
  });

  test('groups map files to their destination directories', () => {
    const args = parseArguments([
      '--repo',
      repo,
      '--base=main',
      '--dest',
      'to-A',
      './from-A/some1.txt',
      './from-A/some2.txt',
      './from-A/some3.txt',
      '--dest=to-B',
      './from-B/some4.txt',
      './from-B/some5.txt',
      '--dry-run'
    ]);
    expect(args).toEqual({
      repo: { owner: 'me', name: 'notes' },
      base: 'main',
      dryRun: true,
      entries: [
        { source: './from-A/some1.txt', target: 'to-A/some1.txt' },
        { source: './from-A/some2.txt', target: 'to-A/some2.txt' },
        { source: './from-A/some3.txt', target: 'to-A/some3.txt' },
        { source: './from-B/some4.txt', target: 'to-B/some4.txt' },
        { source: './from-B/some5.txt', target: 'to-B/some5.txt' }
      ]
    });
    expect(parseArguments(['--dest', '.', 'a/x.txt', '--repo', repo]).entries).toEqual([{ source: 'a/x.txt', target: 'x.txt' }]);
  });

  test.each([
    [[], /--repo/],
    [['--repo', repo], /--dest/],
    [['--repo', repo, 'a.txt', '--dest', 'd'], /до --dest/],
    [['--repo', repo, '--dest', 'd'], /Нет файлов для --dest d/],
    [['--repo', repo, '--dest', 'd', '--dest', 'e', 'a.txt'], /Нет файлов для --dest d/],
    [['--repo', repo, '--repo', repo, '--dest', 'd', 'a.txt'], /повторно: --repo/],
    [['--repo', repo, '--base', 'main', '--base=dev', '--dest', 'd', 'a.txt'], /повторно: --base/],
    [['--repo', repo, '--dry-run', '--dry-run', '--dest', 'd', 'a.txt'], /повторно: --dry-run/],
    [['--repo', '--dest', 'd', 'a.txt'], /Нет значения для --repo/],
    [['--repo=', '--dest', 'd', 'a.txt'], /Нет значения для --repo/],
    [['--repo', repo, '--base', '--force', '--dest', 'd', 'a.txt'], /Нет значения для --base/],
    [['--repo', repo, '--base', 'a..b', '--dest', 'd', 'a.txt'], /недопустимое имя ветки/],
    [['--repo', repo, '--dest', '../up', 'a.txt'], /выход из каталога/],
    [['--repo', repo, '--dest', '.git/hooks', 'a.txt'], /начинается с точки/],
    [['--repo', repo, '--dest', 'd', '.env'], /начинается с точки/],
    [['--repo', repo, '--dest', 'd', '/etc/passwd'], /относительный путь/],
    [['--repo', repo, '--dest', 'd', 'a.txt', '--dry-run=1'], /Неизвестный параметр/],
    [['--repo', repo, '--dest', 'd', 'a.txt', '-y'], /Неизвестный параметр/],
    [['--repo', 'https://evil.example/me/notes', '--dest', 'd', 'a.txt'], /--repo/]
  ])('reject %j', (args, message) => {
    expect(() => parseArguments(args)).toThrow(message);
  });
});

test('runtime check accepts macOS and Linux with Node.js 24.12', () => {
  expect(() => checkRuntime('darwin', '24.12.0')).not.toThrow();
  expect(() => checkRuntime('linux', '26.0.0')).not.toThrow();
  expect(() => checkRuntime('win32', '24.12.0')).toThrow(/macOS и Linux/);
  expect(() => checkRuntime('linux', '24.11.0')).toThrow(/24\.12/);
});
