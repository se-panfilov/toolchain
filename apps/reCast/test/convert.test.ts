import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { convert, freeSpace, parseProgress, placeResult, type Progress } from '@reCast/convert';
import { findTools, probe, type Tools } from '@reCast/media';
import { modes, type Plan } from '@reCast/plan';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-recast-convert-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('progress blocks give time, speed, and the end state', () => {
  expect(parseProgress('frame=10\nout_time_us=12500000\nspeed=3.5x\nprogress=continue\n', 60)).toEqual({ seconds: 12.5, total: 60, speed: 3.5, done: false });
  expect(parseProgress('out_time_us=N/A\nspeed=N/A\nprogress=end\n', 60)).toEqual({ seconds: 0, total: 60, speed: 0, done: true });
  expect(parseProgress('frame=10\n', 60)).toBeUndefined();
});

test('the result never replaces an existing file', (t) => {
  const directory = workspace(t);
  const temporary = join(directory, 'temporary.mp4');
  const wanted = join(directory, 'result.mp4');
  writeFileSync(temporary, 'new');
  writeFileSync(wanted, 'old');
  const placed = placeResult(temporary, wanted);
  expect(placed.renamed).toBe(true);
  expect(placed.output).not.toBe(wanted);
  expect(readFileSync(wanted, 'utf8')).toBe('old');
  expect(readFileSync(placed.output, 'utf8')).toBe('new');
});

test('free space is a positive number', (t) => {
  expect(freeSpace(workspace(t))).toBeGreaterThan(0);
});

// Integration tests need a real FFmpeg with an H.264 encoder. CI runners usually have none.
function realTools(): Tools | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const tools = findTools();
    const encoders = spawnSync(tools.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout;
    return encoders.includes(' libx264 ') ? tools : undefined;
  } catch {
    return undefined;
  }
}
const tools = realTools();

// Stream copy starts at a key frame. The sample has one key frame each second.
function sample(tools: Tools, directory: string): string {
  const input = join(directory, 'source film.mkv');
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8'];
  const result = spawnSync(tools.ffmpeg, [...args, '-map', '0', '-map', '1', '-c:v', 'libx264', '-g', '25', '-c:a', 'flac', input], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return input;
}
function plan(input: string, output: string, id: string, tools: Tools): Plan {
  const mode = modes.find((item) => item.id === id);
  if (!mode) throw new Error(`unknown mode ${id}`);
  const media = probe(tools, input);
  return { input, output, mode, media, audio: media.audio[0], subtitle: undefined, start: 2, length: mode.sample ? 3 : media.duration };
}

test.skipIf(!tools)('remux makes an MP4 with copied video and AAC audio and leaves no temporary files', async (t) => {
  if (!tools) return;
  const directory = workspace(t);
  const input = sample(tools, directory);
  const before = readFileSync(input);
  const output = join(directory, 'result.mp4');
  const updates: Progress[] = [];
  const result = await convert(tools, plan(input, output, 'remux', tools), (progress) => updates.push(progress));
  expect(result).toEqual({ output, renamed: false, interrupted: false });
  const info = probe(tools, output);
  expect(info.video.codec).toBe('h264');
  expect(info.audio.map((stream) => stream.codec)).toEqual(['aac']);
  expect(updates.at(-1)?.done).toBe(true);
  expect(readFileSync(input).equals(before)).toBe(true);
  expect(readdirSync(directory).sort()).toEqual(['result.mp4', 'source film.mkv']);
});

test.skipIf(!tools)('a sample has the requested length', async (t) => {
  if (!tools) return;
  const directory = workspace(t);
  const input = sample(tools, directory);
  const output = join(directory, 'sample.mp4');
  await convert(tools, plan(input, output, 'remux-test', tools), () => undefined);
  const duration = probe(tools, output).duration;
  expect(duration).toBeGreaterThan(2);
  expect(duration).toBeLessThan(4.5);
});

test.skipIf(!tools)('an FFmpeg failure removes the partial file and keeps the destination free', async (t) => {
  if (!tools) return;
  const directory = workspace(t);
  const input = sample(tools, directory);
  const output = join(directory, 'broken.mp4');
  const broken = plan(input, output, 'remux', tools);
  // A stream index that does not exist makes FFmpeg stop after the temporary directory is created.
  broken.media = { ...broken.media, video: { ...broken.media.video, index: 99 } };
  await expect(convert(tools, broken, () => undefined)).rejects.toThrow(/FFmpeg завершился с ошибкой/);
  expect(readdirSync(directory)).toEqual(['source film.mkv']);
});

test.skipIf(!tools)('a playlist with a video extension is not opened', (t) => {
  if (!tools) return;
  const directory = workspace(t);
  const input = join(directory, 'playlist.mkv');
  writeFileSync(input, '#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:9/segment.ts\n');
  expect(() => probe(tools, input)).toThrow();
});

test.skipIf(process.platform === 'win32')('an interruption stops FFmpeg and removes the partial file', async (t) => {
  const directory = workspace(t);
  const marker = join(directory, 'started');
  const fake = join(directory, 'ffmpeg');
  // The fake tool writes a partial output file, reports the start, and waits for a signal.
  writeFileSync(fake, `#!/bin/sh\nfor last; do :; done\nprintf partial > "\${last#file:}"\n: > '${marker}'\ntrap 'exit 255' INT\nwhile :; do sleep 0.1; done\n`);
  chmodSync(fake, 0o755);
  const input = join(directory, 'film.mkv');
  writeFileSync(input, '');
  const mode = modes.find((item) => item.id === 'remux');
  if (!mode) throw new Error('remux mode is missing');
  const media = { duration: 60, size: 1, container: 'matroska', video: { index: 0, codec: 'h264', width: 1, height: 1, pixelFormat: '', transfer: '', hdr: false }, audio: [], subtitles: [] };
  const output = join(directory, 'result.mp4');
  const running = convert({ ffmpeg: fake, ffprobe: fake }, { input, output, mode, media, audio: undefined, subtitle: undefined, start: 0, length: 60 }, () => undefined);
  const deadline = Date.now() + 10000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(readdirSync(directory).some((name) => name.startsWith('.recast-'))).toBe(true);
  process.emit('SIGINT');
  await expect(running).resolves.toEqual({ output, renamed: false, interrupted: true });
  expect(readdirSync(directory).sort()).toEqual(['ffmpeg', 'film.mkv', 'started']);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only destination stops before FFmpeg starts', async (t) => {
  const directory = workspace(t);
  const fake = join(directory, 'ffmpeg');
  const marker = join(directory, 'started');
  writeFileSync(fake, `#!/bin/sh\n: > '${marker}'\n`);
  chmodSync(fake, 0o755);
  const locked = join(directory, 'locked');
  mkdirSync(locked, 0o500);
  t.onTestFinished(() => {
    chmodSync(locked, 0o700);
  });
  const mode = modes.find((item) => item.id === 'remux');
  if (!mode) throw new Error('remux mode is missing');
  const media = { duration: 60, size: 1, container: 'matroska', video: { index: 0, codec: 'h264', width: 1, height: 1, pixelFormat: '', transfer: '', hdr: false }, audio: [], subtitles: [] };
  const running = convert({ ffmpeg: fake, ffprobe: fake }, { input: fake, output: join(locked, 'out.mp4'), mode, media, audio: undefined, subtitle: undefined, start: 0, length: 60 }, () => undefined);
  await expect(running).rejects.toThrow(/Нет доступа на запись/);
  expect(existsSync(marker)).toBe(false);
});

test.skipIf(!tools)('a WebVTT subtitle is written next to the MP4 file with the same name', async (t) => {
  if (!tools) return;
  const directory = workspace(t);
  const srt = join(directory, 'source.srt');
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:05,000 --> 00:00:06,500\nSecond\n');
  const input = join(directory, 'film.mkv');
  const made = spawnSync(
    tools.ffmpeg,
    ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25', '-i', srt, '-t', '8', '-map', '0', '-map', '1', '-c:v', 'libx264', '-g', '25', '-c:s', 'srt', input],
    { encoding: 'utf8' }
  );
  if (made.status !== 0) throw new Error(made.stderr);
  const output = join(directory, 'result.mp4');
  const base = plan(input, output, 'remux-test', tools);
  const subtitle = base.media.subtitles[0];
  if (!subtitle) throw new Error('subtitle stream is missing');
  const result = await convert(tools, { ...base, subtitle: { stream: subtitle, format: 'vtt' }, start: 4 }, () => undefined);
  expect(result.subtitles).toBe(join(directory, 'result.vtt'));
  const vtt = readFileSync(join(directory, 'result.vtt'), 'utf8');
  // The sample starts at 4 s, so the second cue moves to 1 s. The first cue is outside the sample.
  expect(vtt.startsWith('WEBVTT')).toBe(true);
  expect(vtt).toContain('Second');
  expect(vtt).not.toContain('First');
  expect(readdirSync(directory).sort()).toEqual(['film.mkv', 'result.mp4', 'result.vtt', 'source.srt']);
});
