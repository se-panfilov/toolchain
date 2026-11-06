import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { audioLabel, checkRuntime, parseArguments, progressLine } from '@reCast/cli';
import { expect, test } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' }, timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('help and version work on every platform', () => {
  const help = run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('tx-recast [ФАЙЛ]');
  const version = run(['--version']);
  expect(version.stdout.trim()).toBe(manifest.version);
});

test('the built entry point is executable', () => {
  if (process.platform !== 'win32') expect(statSync(cli).mode & 0o111).not.toBe(0);
  expect(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
});

test('an unknown option stops before any work', () => {
  const result = run(['--force']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Неизвестный параметр: --force');
});

test('without a TTY the CLI stops and does not start FFmpeg', () => {
  const result = run(['film.mkv']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(process.platform === 'darwin' ? /Нужен интерактивный терминал/ : /только macOS/);
});

test('arguments accept one file and a file name after --', () => {
  expect(parseArguments([])).toEqual({ input: undefined });
  expect(parseArguments(['film.mkv'])).toEqual({ input: 'film.mkv' });
  expect(parseArguments(['--', '-film.mkv'])).toEqual({ input: '-film.mkv' });
  expect(() => parseArguments(['a.mkv', 'b.mkv'])).toThrow(/один файл/);
  expect(() => parseArguments(['-x'])).toThrow(/Неизвестный параметр/);
});

test('the runtime check needs macOS and Node.js 24.12', () => {
  expect(() => {
    checkRuntime('darwin', '24.12.0');
  }).not.toThrow();
  expect(() => {
    checkRuntime('darwin', '24.11.1');
  }).toThrow(/24\.12/);
  expect(() => {
    checkRuntime('linux', '26.0.0');
  }).toThrow(/только macOS/);
});

test('the progress line fits the terminal width', () => {
  const line = progressLine({ seconds: 30, total: 60, speed: 2, done: false }, 80);
  expect(line).toContain(' 50%');
  expect(line).toContain('осталось 00:00:15');
  expect(line.length).toBeLessThanOrEqual(80);
  expect(progressLine({ seconds: 59.9, total: 60, speed: 0, done: true }, 40)).toContain('100%');
});

test('audio labels show language, codec, layout, and title', () => {
  expect(audioLabel({ index: 3, codec: 'eac3', channels: 6, language: 'rus', title: 'Dub', isDefault: true }, 0)).toBe('#1 · rus · eac3 · 5.1 · Dub');
  expect(audioLabel({ index: 1, codec: 'aac', channels: 2, language: '', title: '', isDefault: false }, 1)).toBe('#2 · und · aac · стерео');
});
