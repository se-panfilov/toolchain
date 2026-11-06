import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { type AudioStream, inputFormats, type MediaInfo, type SubtitleStream } from '@reCast/media';

export type Method = 'remux' | 'h264';
export type Mode = { id: string; method: Method; sample: boolean; label: string; suffix: string };
export const modes: readonly Mode[] = [
  { id: 'remux-test', method: 'remux', sample: true, label: 'Тест REMUX, 60 с — почти мгновенно, без потери качества', suffix: 'cast-remux-test' },
  { id: 'remux', method: 'remux', sample: false, label: 'REMUX целиком — очень быстро, без потери качества', suffix: 'cast-remux' },
  { id: 'h264-test', method: 'h264', sample: true, label: 'Тест H.264, 60 с — аппаратное кодирование', suffix: 'cast-h264-test' },
  { id: 'h264', method: 'h264', sample: false, label: 'H.264 целиком — аппаратное кодирование', suffix: 'cast-h264' }
];

export const sampleLength = 60;
export const sampleStart = 300;
/** Video codecs that Chromecast devices play from MP4 without conversion. */
export const remuxVideo = new Set(['h264', 'hevc']);
/** Audio codecs that stay unchanged in MP4. Other codecs, such as DTS and TrueHD, become AAC. */
export const copyAudio = new Set(['aac', 'mp3', 'ac3', 'eac3']);
export const videoBitrate = 8_000_000;
export const audioBitrate = 192_000;
const maxWidth = 1920;
const maxHeight = 1080;

/** WebVTT is a separate file next to the MP4 file. A burned-in subtitle becomes a part of the picture. */
export type SubtitleFormat = 'vtt' | 'burn';
export type SubtitleChoice = { stream: SubtitleStream; format: SubtitleFormat };
export type Plan = {
  input: string;
  output: string;
  mode: Mode;
  media: MediaInfo;
  audio: AudioStream | undefined;
  subtitle: SubtitleChoice | undefined;
  start: number;
  length: number;
};
/** The name of the extracted subtitle file in the private working directory. FFmpeg starts in that directory. */
export const subtitleFile = 'subtitles.ass';

/**
 * Read a path from a drop into Terminal or from a paste.
 * Terminal escapes spaces and special characters with a backslash. A paste can add one pair of quotes.
 */
export function parseDroppedPath(raw: string, cwd = process.cwd()): string {
  let value = raw.trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
  if (value === '~' || value.startsWith('~/')) value = join(homedir(), value.slice(1));
  const direct = resolve(cwd, value);
  if (existsSync(direct)) return direct;
  return resolve(cwd, value.replace(/\\(.)/gu, '$1'));
}

/** Accept seconds or [HH:]MM:SS. */
export function parseTime(value: string): number {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)(\.\d+)?$/.exec(text);
  if (!match) throw new Error('Формат времени: ЧЧ:ММ:СС, ММ:СС или секунды.');
  const [, hours = '0', minutes = '0', seconds = '0', fraction = ''] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction || 0);
}
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

/** Start the sample at 5 minutes. Short files start at the beginning. */
export function defaultStart(duration: number): number {
  return duration >= sampleStart + sampleLength ? sampleStart : 0;
}
export function validateStart(start: number, duration: number): number {
  if (!Number.isFinite(start) || start < 0) throw new Error('Начало должно быть неотрицательным.');
  if (duration > 0 && start >= duration) throw new Error(`Начало должно быть меньше длительности (${formatTime(duration)}).`);
  return start;
}

export function availableModes(media: MediaInfo): Mode[] {
  return modes.filter((mode) => mode.method === 'h264' || remuxVideo.has(media.video.codec));
}

/** Prefer the stream that the file marks as default. */
export function defaultAudio(media: MediaInfo): number {
  return Math.max(
    0,
    media.audio.findIndex((stream) => stream.isDefault)
  );
}

export function findMode(id: string): Mode {
  const mode = modes.find((item) => item.id === id);
  if (!mode) throw new Error(`Неизвестный режим: ${id}. Допустимо: ${modes.map((item) => item.id).join(', ')}.`);
  return mode;
}

/** Subtitle formats that the mode supports for this stream. REMUX keeps the picture, so it cannot burn in. */
export function subtitleFormats(mode: Mode, stream: SubtitleStream): SubtitleFormat[] {
  const formats: SubtitleFormat[] = [];
  if (stream.kind === 'text') formats.push('vtt');
  if (mode.method === 'h264') formats.push('burn');
  return formats;
}
export function usableSubtitles(media: MediaInfo, mode: Mode): SubtitleStream[] {
  return media.subtitles.filter((stream) => subtitleFormats(mode, stream).length > 0);
}

/** The WebVTT file has the name of the MP4 file, so sender apps find it. */
export function subtitlePath(output: string): string {
  return `${output.slice(0, output.length - extname(output).length)}.vtt`;
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
/** A name is in use when the MP4 file or its WebVTT file exists. */
export function taken(path: string): boolean {
  return exists(path) || (extname(path).toLowerCase() === '.mp4' && exists(subtitlePath(path)));
}

/** Add a time stamp when the name is in use. Never offer an existing path. */
export function uniquePath(wanted: string, now = new Date()): string {
  if (!taken(wanted)) return wanted;
  const extension = extname(wanted);
  const base = wanted.slice(0, wanted.length - extension.length);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = `${base}-${stamp(now)}${attempt ? `-${attempt + 1}` : ''}${extension}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('Не удалось подобрать свободное имя файла.');
}

export function defaultOutput(input: string, mode: Mode, now = new Date()): string {
  const extension = extname(input);
  const stem = basename(input, extension) || 'video';
  return uniquePath(join(dirname(input), `${stem}-${mode.suffix}.mp4`), now);
}

/** Check the destination before the start. The final write also refuses an existing file. */
export function validateOutput(output: string, input: string): string {
  if (!output) throw new Error('Укажите путь к результату.');
  if (!isAbsolute(output)) throw new Error('Нужен абсолютный путь.');
  if (extname(output).toLowerCase() !== '.mp4') throw new Error('Результат должен иметь расширение .mp4.');
  if (/[\p{Cc}]/u.test(output)) throw new Error('Путь содержит управляющие символы.');
  if (resolve(output) === resolve(input) || resolve(subtitlePath(output)) === resolve(input)) throw new Error('Результат не может заменить исходный файл.');
  if (exists(output)) throw new Error('Файл уже существует. Выберите другое имя.');
  if (exists(subtitlePath(output))) throw new Error(`Файл субтитров уже существует: ${subtitlePath(output)}. Выберите другое имя.`);
  let parent;
  try {
    parent = statSync(dirname(output));
  } catch {
    throw new Error('Каталог для результата не существует.');
  }
  if (!parent.isDirectory()) throw new Error('Каталог для результата не существует.');
  return output;
}

/** Level 4.1 allows at most 1080p. Keep the aspect ratio and even dimensions. */
export function targetSize(media: MediaInfo): { width: number; height: number } | undefined {
  const { width, height } = media.video;
  if (width <= maxWidth && height <= maxHeight) return undefined;
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return { width: Math.max(2, Math.floor((width * ratio) / 2) * 2), height: Math.max(2, Math.floor((height * ratio) / 2) * 2) };
}

/**
 * The tone map converts HDR10 or HLG into SDR BT.709. SDR sources get only a pixel format change.
 * Text subtitles render after the tone map, so their colors stay correct.
 */
export function videoFilter(media: MediaInfo, subtitle?: SubtitleChoice, start = 0): string {
  const filters: string[] = [];
  const size = targetSize(media);
  if (size) filters.push(`scale=${size.width}:${size.height}`);
  if (media.video.hdr) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  filters.push('format=yuv420p');
  if (subtitle?.format === 'burn' && subtitle.stream.kind === 'text') {
    // A sample starts its timestamps at zero. Move them to the source time for libass and back after it.
    if (start > 0) filters.push(`setpts=PTS+${start}/TB`, `subtitles=${subtitleFile}`, 'setpts=PTS-STARTPTS');
    else filters.push(`subtitles=${subtitleFile}`);
  }
  return filters.join(',');
}

/** Image subtitles go over the converted picture. The subtitle canvas is scaled to the picture size. */
export function overlayGraph(media: MediaInfo, stream: SubtitleStream): string {
  const size = targetSize(media) ?? { width: media.video.width, height: media.video.height };
  return `[0:${media.video.index}]${videoFilter(media)}[v];[0:${stream.index}]scale=${size.width}:${size.height}[s];[v][s]overlay=format=auto,format=yuv420p[out]`;
}

export function audioCopied(plan: Pick<Plan, 'mode' | 'audio'>): boolean {
  return plan.mode.method === 'remux' && plan.audio !== undefined && copyAudio.has(plan.audio.codec);
}

function inputArgs(plan: Plan): string[] {
  const args: string[] = [];
  if (plan.mode.sample) args.push('-ss', String(plan.start));
  args.push('-protocol_whitelist', 'file', '-format_whitelist', inputFormats, '-i', `file:${plan.input}`);
  return args;
}

/**
 * Make the FFmpeg arguments. Paths are absolute and use the file: prefix, so FFmpeg cannot read them as options.
 * A WebVTT subtitle is a second output of the same process. Each output gets its own length limit.
 */
export function ffmpegArgs(plan: Plan, target: string, subtitleTarget = subtitlePath(target)): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-n', ...inputArgs(plan)];
  const limit = plan.mode.sample ? ['-t', String(plan.length)] : [];
  const overlay = plan.mode.method === 'h264' && plan.subtitle?.format === 'burn' && plan.subtitle.stream.kind === 'image';
  args.push(...limit);
  if (overlay && plan.subtitle) args.push('-filter_complex', overlayGraph(plan.media, plan.subtitle.stream), '-map', '[out]');
  else args.push('-map', `0:${plan.media.video.index}`);
  if (plan.audio) args.push('-map', `0:${plan.audio.index}`);
  args.push('-sn', '-dn', '-map_chapters', '-1');
  if (plan.mode.method === 'remux') {
    args.push('-c:v', 'copy');
    // Apple players and Chromecast expect the hvc1 tag for HEVC in MP4.
    if (plan.media.video.codec === 'hevc') args.push('-tag:v', 'hvc1');
    args.push('-avoid_negative_ts', 'make_zero');
  } else {
    if (!overlay) args.push('-vf', videoFilter(plan.media, plan.subtitle, plan.mode.sample ? plan.start : 0));
    args.push('-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-level:v', '4.1', '-b:v', String(videoBitrate), '-pix_fmt', 'yuv420p');
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv');
  }
  if (!plan.audio) args.push('-an');
  else if (audioCopied(plan)) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', String(audioBitrate), '-ac', '2');
  args.push('-movflags', '+faststart', '-f', 'mp4', `file:${target}`);
  if (plan.subtitle?.format === 'vtt') {
    args.push(...limit, '-map', `0:${plan.subtitle.stream.index}`, '-vn', '-an', '-dn', '-c:s', 'webvtt', '-f', 'webvtt', `file:${subtitleTarget}`);
  }
  return args;
}

/** Extract a text subtitle for libass. The whole stream is extracted, so a sample keeps the source times. */
export function extractArgs(plan: Plan, target: string): string[] | undefined {
  if (plan.mode.method !== 'h264' || plan.subtitle?.format !== 'burn' || plan.subtitle.stream.kind !== 'text') return undefined;
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-n',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    inputFormats,
    '-i',
    `file:${plan.input}`,
    '-map',
    `0:${plan.subtitle.stream.index}`,
    '-c:s',
    'ass',
    '-f',
    'ass',
    `file:${target}`
  ];
}

/** Rough result size for the free space check. */
export function estimateSize(plan: Plan): number {
  const duration = plan.media.duration > 0 ? plan.media.duration : 0;
  const seconds = plan.mode.sample ? Math.min(plan.length, Math.max(0, duration - plan.start)) : Math.max(0, duration - plan.start);
  if (plan.mode.method === 'remux') return duration > 0 ? Math.ceil((plan.media.size * seconds) / duration) : plan.media.size;
  return Math.ceil(((videoBitrate + audioBitrate) / 8) * seconds * 1.1);
}
