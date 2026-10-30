import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { audioLabel, checkRuntime, parseArguments, progressLine, resolvePlan, subtitleLabel } from '@reCast/cli';
import type { MediaInfo } from '@reCast/media';
import type { Plan } from '@reCast/plan';
import { describe, expect, test, type TestContext } from 'vitest';

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

test('without a TTY and without --yes the CLI stops and does not start FFmpeg', () => {
  const result = run(['film.mkv']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(process.platform === 'darwin' ? /Нужен интерактивный терминал \(TTY\) или параметр --yes/ : /только macOS/);
  expect(result.stdout).toBe('');
});

const none = { input: undefined, mode: undefined, audio: undefined, subtitles: undefined, subtitleFormat: undefined, start: undefined, output: undefined, yes: false, dryRun: false };

test('arguments accept one file and a file name after --', () => {
  expect(parseArguments([])).toEqual(none);
  expect(parseArguments(['film.mkv'])).toEqual({ ...none, input: 'film.mkv' });
  expect(parseArguments(['--', '-film.mkv'])).toEqual({ ...none, input: '-film.mkv' });
  expect(() => parseArguments(['a.mkv', 'b.mkv'])).toThrow(/один файл/);
  expect(() => parseArguments(['-x'])).toThrow(/Неизвестный параметр/);
});

test('options accept separate and inline values', () => {
  expect(parseArguments(['film.mkv', '--mode', 'h264-test', '--audio=2', '--subtitles', '1', '--subtitle-format=burn', '--start', '1:00', '--output', 'out.mp4', '-y', '--dry-run'])).toEqual({
    input: 'film.mkv',
    mode: 'h264-test',
    audio: '2',
    subtitles: '1',
    subtitleFormat: 'burn',
    start: '1:00',
    output: 'out.mp4',
    yes: true,
    dryRun: true
  });
  expect(parseArguments(['--output=-dash.mp4', 'film.mkv']).output).toBe('-dash.mp4');
});

test.each([
  [['--mode'], /Нет значения для --mode/],
  [['--mode='], /Нет значения для --mode/],
  [['--mode', '--yes'], /Нет значения для --mode/],
  [['--mode', 'remux', '--mode', 'h264'], /повторно/],
  [['-y', '--yes', 'a.mkv', '--mode', 'remux'], /повторно/],
  [['--yes=1'], /Неизвестный параметр/],
  [['--subtitle-format', 'vtt'], /требует --subtitles N/],
  [['--subtitles', 'none', '--subtitle-format', 'vtt'], /требует --subtitles N/],
  [['--yes', 'a.mkv'], /укажите ФАЙЛ и --mode/],
  [['--yes', '--mode', 'remux'], /укажите ФАЙЛ и --mode/]
])('arguments %j are rejected', (args, message) => {
  expect(() => parseArguments(args)).toThrow(message);
});

describe('plan without questions', () => {
  const quiet = (): void => undefined;
  function workspace(t: TestContext): string {
    const directory = mkdtempSync(join(tmpdir(), 'tx-recast-cli-test-'));
    t.onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    return directory;
  }
  function media(): MediaInfo {
    return {
      duration: 3600,
      size: 1000,
      container: 'matroska,webm',
      video: { index: 0, codec: 'hevc', width: 1920, height: 1080, pixelFormat: 'yuv420p', transfer: 'bt709', hdr: false },
      audio: [
        { index: 1, codec: 'dts', channels: 6, language: 'eng', title: '', isDefault: false },
        { index: 2, codec: 'ac3', channels: 6, language: 'rus', title: '', isDefault: true }
      ],
      subtitles: [
        { index: 3, codec: 'subrip', language: 'rus', title: '', isDefault: false, forced: false, kind: 'text' },
        { index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng', title: '', isDefault: false, forced: false, kind: 'image' }
      ]
    };
  }
  function resolveWith(t: TestContext, args: string[]): Promise<Plan> {
    const directory = workspace(t);
    const input = join(directory, 'film.mkv');
    writeFileSync(input, '');
    return resolvePlan(input, media(), parseArguments([input, ...args]), undefined, quiet);
  }

  test('defaults: the default audio stream, no subtitles, the 5-minute start, and a name next to the input', async (t) => {
    const result = await resolveWith(t, ['--mode', 'remux-test', '--yes']);
    expect(result.audio?.index).toBe(2);
    expect(result.subtitle).toBeUndefined();
    expect(result.start).toBe(300);
    expect(result.output.endsWith('film-cast-remux-test.mp4')).toBe(true);
  });

  test('options select the streams, the format, the start, and the output', async (t) => {
    const result = await resolveWith(t, ['--mode', 'h264-test', '--audio', '1', '--subtitles', '2', '--start', '00:10:00', '--output', join(tmpdir(), `recast-${process.pid}-out.mp4`)]);
    expect(result.audio?.index).toBe(1);
    expect(result.subtitle).toEqual({ stream: media().subtitles[1], format: 'burn' });
    expect(result.start).toBe(600);
    expect(result.output).toBe(join(tmpdir(), `recast-${process.pid}-out.mp4`));
    expect((await resolveWith(t, ['--mode', 'remux', '--audio', 'none', '--subtitles', '1'])).subtitle?.format).toBe('vtt');
    expect((await resolveWith(t, ['--mode', 'remux', '--audio', 'none'])).audio).toBeUndefined();
  });

  test.for([
    [['--mode', 'fast'], /Неизвестный режим/],
    [['--mode', 'remux', '--audio', '3'], /нет номера 3/],
    [['--mode', 'remux', '--audio', '0'], /номер из списка/],
    [['--mode', 'remux', '--audio', '1.5'], /номер из списка/],
    [['--mode', 'remux', '--subtitles', '2'], /можно только вшить/],
    [['--mode', 'remux', '--subtitles', '1', '--subtitle-format', 'burn'], /допустимо vtt/],
    [['--mode', 'h264', '--subtitles', '1', '--subtitle-format', 'srt'], /допустимо vtt или burn/],
    [['--mode', 'remux', '--start', '10'], /только для режимов remux-test и h264-test/],
    [['--mode', 'remux-test', '--start', '2:00:00'], /меньше длительности/],
    [['--mode', 'remux', '--output', 'relative.mkv'], /\.mp4/]
  ] as const)('invalid values %j stop before any write', async ([args, message], t) => {
    await expect(resolveWith(t, [...args])).rejects.toThrow(message);
  });
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

test('subtitle labels show the kind and the forced flag', () => {
  expect(subtitleLabel({ index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'Signs', isDefault: false, forced: true, kind: 'image' }, 1)).toBe(
    '#2 · eng · hdmv_pgs_subtitle · изображения · принудительные · Signs'
  );
});
