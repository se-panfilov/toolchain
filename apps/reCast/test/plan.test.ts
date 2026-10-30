import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AudioStream, MediaInfo, SubtitleStream } from '@reCast/media';
import {
  availableModes,
  defaultAudio,
  defaultOutput,
  defaultStart,
  estimateSize,
  extractArgs,
  ffmpegArgs,
  findMode,
  formatTime,
  type Mode,
  modes,
  overlayGraph,
  parseDroppedPath,
  parseTime,
  type Plan,
  subtitleFile,
  subtitleFormats,
  subtitlePath,
  targetSize,
  uniquePath,
  usableSubtitles,
  validateOutput,
  validateStart,
  videoFilter
} from '@reCast/plan';
import { describe, expect, test, type TestContext } from 'vitest';

const posix = process.platform !== 'win32';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-recast-plan-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function audio(codec: string, overrides: Partial<AudioStream> = {}): AudioStream {
  return { index: 1, codec, channels: 6, language: 'eng', title: '', isDefault: false, ...overrides };
}
function media(overrides: Partial<MediaInfo['video']> = {}, tracks: AudioStream[] = [audio('ac3')]): MediaInfo {
  return {
    duration: 3600,
    size: 4_000_000_000,
    container: 'matroska,webm',
    video: { index: 0, codec: 'hevc', width: 1920, height: 1080, pixelFormat: 'yuv420p10le', transfer: 'bt709', hdr: false, ...overrides },
    audio: tracks,
    subtitles: []
  };
}
function mode(id: string): Mode {
  const found = modes.find((item) => item.id === id);
  if (!found) throw new Error(`unknown mode ${id}`);
  return found;
}
function plan(id: string, info = media(), overrides: Partial<Plan> = {}): Plan {
  const selected = mode(id);
  return {
    input: '/videos/film.mkv',
    output: '/videos/film.mp4',
    mode: selected,
    media: info,
    audio: info.audio[0],
    subtitle: undefined,
    start: selected.sample ? 300 : 0,
    length: selected.sample ? 60 : info.duration,
    ...overrides
  };
}
function after(args: string[], option: string): string | undefined {
  const at = args.indexOf(option);
  return at === -1 ? undefined : args[at + 1];
}

describe.skipIf(!posix)('dropped paths', () => {
  test('a path dropped into Terminal loses the backslash escapes', (t) => {
    const directory = workspace(t);
    const file = join(directory, 'My Film (2024).mkv');
    writeFileSync(file, '');
    expect(parseDroppedPath(`${directory}/My\\ Film\\ \\(2024\\).mkv `)).toBe(file);
  });

  test('one pair of quotes is removed and an existing literal path is kept', (t) => {
    const directory = workspace(t);
    const file = join(directory, 'back\\slash.mkv');
    writeFileSync(file, '');
    expect(parseDroppedPath(`'${file}'`)).toBe(file);
    expect(parseDroppedPath(`"${file}"`)).toBe(file);
  });

  test('a relative path resolves against the working directory', () => {
    expect(parseDroppedPath('film.mkv', '/videos')).toBe('/videos/film.mkv');
  });
});

test.each([
  ['300', 300],
  ['05:00', 300],
  ['1:02:03', 3723],
  ['00:00:01.5', 1.5]
])('time %s is %d seconds', (text, seconds) => {
  expect(parseTime(text)).toBe(seconds);
});

test.each(['', '-5', '1:60', 'abc', '5:00:00:00'])('time %j is rejected', (text) => {
  expect(() => parseTime(text)).toThrow(/Формат времени/);
});

test('time format and sample start', () => {
  expect(formatTime(3723.9)).toBe('01:02:03');
  expect(defaultStart(3600)).toBe(300);
  expect(defaultStart(200)).toBe(0);
  expect(() => validateStart(3600, 3600)).toThrow(/меньше длительности/);
  expect(validateStart(10, 0)).toBe(10);
});

test('remux modes need H.264 or HEVC video', () => {
  expect(availableModes(media()).map((item) => item.id)).toEqual(['remux-test', 'remux', 'h264-test', 'h264']);
  expect(availableModes(media({ codec: 'av1' })).map((item) => item.id)).toEqual(['h264-test', 'h264']);
});

test('the default audio stream has the default disposition', () => {
  expect(defaultAudio(media({}, [audio('ac3'), audio('aac', { index: 2, isDefault: true })]))).toBe(1);
  expect(defaultAudio(media({}, [audio('ac3'), audio('aac', { index: 2 })]))).toBe(0);
  expect(defaultAudio(media({}, []))).toBe(0);
});

describe('FFmpeg arguments', () => {
  test('HEVC remux copies video with the hvc1 tag and keeps AC-3 audio', () => {
    const args = ffmpegArgs(plan('remux'), '/tmp/out.mp4');
    expect(after(args, '-c:v')).toBe('copy');
    expect(after(args, '-tag:v')).toBe('hvc1');
    expect(after(args, '-c:a')).toBe('copy');
    expect(args).not.toContain('-ss');
    expect(args).toContain('-n');
    expect(args).not.toContain('-y');
    expect(args.slice(-3)).toEqual(['-f', 'mp4', 'file:/tmp/out.mp4']);
    expect(after(args, '-i')).toBe('file:/videos/film.mkv');
    expect(after(args, '-protocol_whitelist')).toBe('file');
  });

  test('H.264 remux has no hvc1 tag', () => {
    expect(ffmpegArgs(plan('remux', media({ codec: 'h264' })), '/tmp/out.mp4')).not.toContain('-tag:v');
  });

  test.each(['dts', 'truehd', 'flac'])('remux converts %s audio into AAC stereo', (codec) => {
    const args = ffmpegArgs(plan('remux', media({}, [audio(codec)])), '/tmp/out.mp4');
    expect(after(args, '-c:a')).toBe('aac');
    expect(after(args, '-ac')).toBe('2');
  });

  test('a sample seeks before the input and limits the length', () => {
    const args = ffmpegArgs(plan('remux-test'), '/tmp/out.mp4');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(after(args, '-ss')).toBe('300');
    expect(after(args, '-t')).toBe('60');
  });

  test('the selected streams are mapped by absolute index', () => {
    const info = media({ index: 2 }, [audio('aac', { index: 4 })]);
    const args = ffmpegArgs(plan('h264', info), '/tmp/out.mp4');
    expect(args.filter((_arg, i) => args[i - 1] === '-map')).toEqual(['0:2', '0:4']);
  });

  test('a file without audio gets no audio stream', () => {
    const args = ffmpegArgs(plan('remux', media({}, []), { audio: undefined }), '/tmp/out.mp4');
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  test('H.264 uses VideoToolbox with BT.709 output', () => {
    const args = ffmpegArgs(plan('h264'), '/tmp/out.mp4');
    expect(after(args, '-c:v')).toBe('h264_videotoolbox');
    expect(after(args, '-level:v')).toBe('4.1');
    expect(after(args, '-colorspace')).toBe('bt709');
    expect(after(args, '-c:a')).toBe('aac');
  });
});

test('the tone map applies only to HDR sources', () => {
  expect(videoFilter(media())).toBe('format=yuv420p');
  expect(videoFilter(media({ transfer: 'smpte2084', hdr: true }))).toContain('tonemap=tonemap=hable');
  expect(videoFilter(media({ transfer: 'arib-std-b67', hdr: true }))).toContain('zscale=t=linear');
});

test('sources above 1080p are scaled down for level 4.1 with even dimensions', () => {
  expect(videoFilter(media({ width: 3840, height: 2160 }))).toMatch(/^scale=1920:1080,/);
  expect(targetSize(media({ width: 3840, height: 1606 }))).toEqual({ width: 1920, height: 802 });
  expect(targetSize(media({ width: 2880, height: 2160 }))).toEqual({ width: 1440, height: 1080 });
  expect(videoFilter(media({ width: 1920, height: 800 }))).not.toContain('scale=');
});

function subtitle(kind: 'text' | 'image', overrides: Partial<SubtitleStream> = {}): SubtitleStream {
  return { index: 5, codec: kind === 'text' ? 'subrip' : 'hdmv_pgs_subtitle', language: 'rus', title: '', isDefault: false, forced: false, kind, ...overrides };
}

describe('subtitles', () => {
  test('the formats depend on the subtitle kind and the mode', () => {
    expect(subtitleFormats(mode('remux'), subtitle('text'))).toEqual(['vtt']);
    expect(subtitleFormats(mode('h264'), subtitle('text'))).toEqual(['vtt', 'burn']);
    expect(subtitleFormats(mode('remux-test'), subtitle('image'))).toEqual([]);
    expect(subtitleFormats(mode('h264-test'), subtitle('image'))).toEqual(['burn']);
    const info = { ...media(), subtitles: [subtitle('text'), subtitle('image', { index: 6 })] };
    expect(usableSubtitles(info, mode('remux')).map((stream) => stream.index)).toEqual([5]);
    expect(usableSubtitles(info, mode('h264')).map((stream) => stream.index)).toEqual([5, 6]);
  });

  test('WebVTT is a second output with its own length limit and no video or audio', () => {
    const args = ffmpegArgs(plan('remux-test', media(), { subtitle: { stream: subtitle('text'), format: 'vtt' } }), '/tmp/w/out.mp4', '/tmp/w/out.vtt');
    const mp4 = args.indexOf('file:/tmp/w/out.mp4');
    const tail = args.slice(mp4 + 1);
    expect(tail).toEqual(['-t', '60', '-map', '0:5', '-vn', '-an', '-dn', '-c:s', 'webvtt', '-f', 'webvtt', 'file:/tmp/w/out.vtt']);
    expect(args.slice(0, mp4)).toContain('-sn');
  });

  test('a burned-in text subtitle renders after the tone map from the extracted file', () => {
    const info = media({ transfer: 'smpte2084', hdr: true });
    const choice = { stream: subtitle('text'), format: 'burn' as const };
    const full = after(ffmpegArgs(plan('h264', info, { subtitle: choice }), '/tmp/out.mp4'), '-vf') ?? '';
    expect(full.endsWith(`format=yuv420p,subtitles=${subtitleFile}`)).toBe(true);
    expect(full.indexOf('tonemap')).toBeLessThan(full.indexOf('subtitles='));
    // A sample moves the timestamps to the source time for libass.
    const sample = after(ffmpegArgs(plan('h264-test', info, { subtitle: choice }), '/tmp/out.mp4'), '-vf') ?? '';
    expect(sample.endsWith(`setpts=PTS+300/TB,subtitles=${subtitleFile},setpts=PTS-STARTPTS`)).toBe(true);
  });

  test('the filter graph never contains a user path', () => {
    const info = { ...media(), subtitles: [subtitle('text')] };
    const choice = { stream: subtitle('text'), format: 'burn' as const };
    const evil = plan('h264', info, { input: "/videos/it's:a,[test];x.mkv", output: "/out/a'b:c.mp4", subtitle: choice });
    const graph = after(ffmpegArgs(evil, "/out/.recast-x/a'b:c.mp4"), '-vf') ?? '';
    expect(graph).not.toContain('/');
    expect(extractArgs(evil, '/out/.recast-x/subtitles.ass')).toEqual(expect.arrayContaining(["file:/videos/it's:a,[test];x.mkv", '0:5', 'ass', 'file:/out/.recast-x/subtitles.ass']));
  });

  test('an image subtitle goes over the scaled picture with an overlay', () => {
    const info = media({ width: 3840, height: 2160, hdr: true, transfer: 'smpte2084' });
    const args = ffmpegArgs(plan('h264', info, { subtitle: { stream: subtitle('image', { index: 7 }), format: 'burn' } }), '/tmp/out.mp4');
    expect(args).not.toContain('-vf');
    expect(after(args, '-filter_complex')).toBe(`[0:0]${videoFilter(info)}[v];[0:7]scale=1920:1080[s];[v][s]overlay=format=auto,format=yuv420p[out]`);
    expect(args.filter((_arg, i) => args[i - 1] === '-map')).toEqual(['[out]', '0:1']);
    expect(overlayGraph(media(), subtitle('image'))).toContain('[0:5]scale=1920:1080[s]');
  });

  test('extraction runs only for a burned-in text subtitle', () => {
    expect(extractArgs(plan('h264', media()), '/tmp/s.ass')).toBeUndefined();
    expect(extractArgs(plan('h264', media(), { subtitle: { stream: subtitle('text'), format: 'vtt' } }), '/tmp/s.ass')).toBeUndefined();
    expect(extractArgs(plan('h264', media(), { subtitle: { stream: subtitle('image'), format: 'burn' } }), '/tmp/s.ass')).toBeUndefined();
  });

  test('mode names resolve and unknown names are rejected', () => {
    expect(findMode('h264-test').sample).toBe(true);
    expect(() => findMode('fast')).toThrow(/Неизвестный режим: fast/);
  });
});

describe('output paths', () => {
  test('the default name is next to the input and never an existing file', (t) => {
    const directory = workspace(t);
    const input = join(directory, 'film.mkv');
    writeFileSync(input, '');
    const first = defaultOutput(input, mode('remux'));
    expect(first).toBe(join(directory, 'film-cast-remux.mp4'));
    writeFileSync(first, 'old');
    const second = defaultOutput(input, mode('remux'), new Date(2026, 0, 2, 3, 4, 5));
    expect(second).toBe(join(directory, 'film-cast-remux-20260102-030405.mp4'));
    writeFileSync(second, 'old');
    expect(uniquePath(first, new Date(2026, 0, 2, 3, 4, 5))).toBe(join(directory, 'film-cast-remux-20260102-030405-2.mp4'));
  });

  test('a WebVTT file with the same name makes the name unavailable', (t) => {
    const directory = workspace(t);
    const input = join(directory, 'film.mkv');
    writeFileSync(input, '');
    writeFileSync(join(directory, 'film-cast-remux.vtt'), 'old');
    expect(subtitlePath(join(directory, 'film-cast-remux.mp4'))).toBe(join(directory, 'film-cast-remux.vtt'));
    expect(defaultOutput(input, mode('remux'), new Date(2026, 0, 2, 3, 4, 5))).toBe(join(directory, 'film-cast-remux-20260102-030405.mp4'));
    expect(() => validateOutput(join(directory, 'film-cast-remux.mp4'), input)).toThrow(/Файл субтитров уже существует/);
  });

  test('validation rejects existing files, other extensions, missing directories, and the input', (t) => {
    const directory = workspace(t);
    const input = join(directory, 'film.mkv');
    const existing = join(directory, 'taken.mp4');
    writeFileSync(input, '');
    writeFileSync(existing, '');
    mkdirSync(join(directory, 'folder.mp4'));
    expect(() => validateOutput(existing, input)).toThrow(/уже существует/);
    expect(() => validateOutput(join(directory, 'folder.mp4'), input)).toThrow(/уже существует/);
    expect(() => validateOutput(join(directory, 'out.mkv'), input)).toThrow(/\.mp4/);
    expect(() => validateOutput(join(directory, 'missing', 'out.mp4'), input)).toThrow(/не существует/);
    expect(() => validateOutput('relative.mp4', input)).toThrow(/абсолютный/);
    expect(() => validateOutput(join(directory, 'line\nbreak.mp4'), input)).toThrow(/управляющие/);
    expect(validateOutput(join(directory, 'new.MP4'), input)).toBe(join(directory, 'new.MP4'));
  });

  test.skipIf(!posix)('validation treats a dangling symbolic link as an existing file', async (t) => {
    const { symlinkSync } = await import('node:fs');
    const directory = workspace(t);
    const link = join(directory, 'link.mp4');
    symlinkSync(join(directory, 'missing-target.mp4'), link);
    expect(() => validateOutput(link, join(directory, 'film.mkv'))).toThrow(/уже существует/);
  });
});

test('size estimates follow the mode', () => {
  expect(estimateSize(plan('remux'))).toBe(4_000_000_000);
  expect(estimateSize(plan('remux-test'))).toBe(Math.ceil((4_000_000_000 * 60) / 3600));
  expect(estimateSize(plan('h264-test'))).toBe(Math.ceil(((8_000_000 + 192_000) / 8) * 60 * 1.1));
});
