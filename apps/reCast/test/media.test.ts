import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findTools, isHdr, parseProbe, toolEnvironment } from '@reCast/media';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-recast-media-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function tool(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

const probe = JSON.stringify({
  format: { format_name: 'matroska,webm', duration: '5400.5' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900, disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', disposition: { attached_pic: 0 } },
    { index: 2, codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'eng', title: 'Atmos' }, disposition: { default: 1 } },
    { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'rus' }, disposition: { default: 0 } },
    { index: 4, codec_type: 'subtitle', codec_name: 'subrip' }
  ]
});

test('probe data skips cover images and reads HDR, audio, and subtitles', () => {
  const info = parseProbe(probe, 123);
  expect(info.duration).toBe(5400.5);
  expect(info.size).toBe(123);
  expect(info.video).toEqual({ index: 1, codec: 'hevc', width: 3840, height: 2160, pixelFormat: 'yuv420p10le', transfer: 'smpte2084', hdr: true });
  expect(info.audio).toEqual([
    { index: 2, codec: 'truehd', channels: 8, language: 'eng', title: 'Atmos', isDefault: true },
    { index: 3, codec: 'ac3', channels: 6, language: 'rus', title: '', isDefault: false }
  ]);
  expect(info.subtitles).toBe(1);
});

test('probe data without a video stream or with invalid JSON is rejected', () => {
  expect(() => parseProbe(JSON.stringify({ format: {}, streams: [{ index: 0, codec_type: 'audio' }] }), 1)).toThrow(/нет видеодорожки/);
  expect(() => parseProbe('not json', 1)).toThrow(/некорректный ответ/);
  expect(() => parseProbe('null', 1)).toThrow(/нет видеодорожки/);
});

test('missing or malformed numbers become zero', () => {
  const info = parseProbe(JSON.stringify({ format: { duration: 'N/A' }, streams: [{ codec_type: 'video', width: 'wide' }] }), 0);
  expect(info.duration).toBe(0);
  expect(info.video.width).toBe(0);
  expect(info.video.hdr).toBe(false);
});

test.each([
  ['smpte2084', true],
  ['arib-std-b67', true],
  ['bt709', false],
  ['', false]
])('transfer %j is HDR: %s', (transfer, expected) => {
  expect(isHdr(transfer)).toBe(expected);
});

test('the tool environment drops user variables', () => {
  const env = toolEnvironment();
  expect(Object.keys(env).sort()).toEqual(['AV_LOG_FORCE_NOCOLOR', 'PATH']);
  expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
});

test.skipIf(process.platform === 'win32')('Homebrew directories come before PATH, and FFprobe must be next to FFmpeg', (t) => {
  const directory = workspace(t);
  const brew = join(directory, 'brew');
  const other = join(directory, 'other');
  tool(other, 'ffmpeg');
  tool(other, 'ffprobe');
  tool(brew, 'ffmpeg');
  // FFmpeg without FFprobe in the first directory is skipped.
  expect(findTools(other, [brew])).toEqual({ ffmpeg: join(other, 'ffmpeg'), ffprobe: join(other, 'ffprobe') });
  tool(brew, 'ffprobe');
  expect(findTools(other, [brew])).toEqual({ ffmpeg: join(brew, 'ffmpeg'), ffprobe: join(brew, 'ffprobe') });
});

test.skipIf(process.platform === 'win32')('relative PATH entries, directories, and files without the execute bit are ignored', (t) => {
  const directory = workspace(t);
  const plain = join(directory, 'plain');
  mkdirSync(join(plain, 'ffmpeg'), { recursive: true });
  const notExecutable = join(directory, 'noexec');
  mkdirSync(notExecutable);
  writeFileSync(join(notExecutable, 'ffmpeg'), '');
  writeFileSync(join(notExecutable, 'ffprobe'), '');
  expect(() => findTools(`relative/bin:${plain}:${notExecutable}`, [])).toThrow(/brew install ffmpeg/);
});
