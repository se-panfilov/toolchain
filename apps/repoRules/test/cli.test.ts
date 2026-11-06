import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArguments } from '@repoRules/cli';
import { describe, expect, test } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; files: string[] };

function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...env }, timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('built CLI', () => {
  test('help and version work without a token or a terminal', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('tx-reporules [--source OWNER/REPO]');
    expect(run(['--version']).stdout.trim()).toBe(manifest.version);
  });

  test('without a TTY the run stops before authentication and network access', () => {
    const result = run(['--source', 'me/template', '--target', 'me/project'], { GH_TOKEN: 'test-token-0123456789abcdef' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Нужен интерактивный терминал (TTY)');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('test-token');
  });

  test('an unknown option stops before any work', () => {
    const result = run(['--yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Неизвестный параметр: --yes');
  });

  test('the entry point is executable and every built module is published', () => {
    const fd = openSync(cli, 'r');
    try {
      if (process.platform !== 'win32') expect(fstatSync(fd).mode & 0o111).not.toBe(0);
      expect(readFileSync(fd, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    } finally {
      closeSync(fd);
    }
    const built = readdirSync(fileURLToPath(new URL('../dist/src/', import.meta.url))).map((name) => `dist/src/${name}`);
    expect(manifest.files.filter((file) => file.startsWith('dist/')).sort()).toEqual(built.sort());
  });
});

describe('arguments', () => {
  test('both forms are accepted', () => {
    expect(parseArguments(['--source', 'me/a', '--target=https://github.com/me/b', '--dry-run'])).toMatchObject({ source: 'me/a', target: 'https://github.com/me/b', dryRun: true });
  });

  test.each([
    [['--source'], 'Нет значения для --source'],
    [['--source', '--dry-run'], 'Нет значения для --source'],
    [['--source', 'me/a', '--source', 'me/b'], 'Параметр повторяется: --source'],
    [['--dry-run=yes'], 'не принимает значение'],
    [['--target', 'gitlab.com/me/b'], 'Нужен репозиторий GitHub']
  ])('%j is refused', (args, message) => {
    expect(() => parseArguments(args)).toThrow(message);
  });
});
