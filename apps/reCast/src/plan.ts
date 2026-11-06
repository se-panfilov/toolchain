import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { type AudioStream, inputFormats, type MediaInfo } from '@reCast/media';

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

export type Plan = {
  input: string;
  output: string;
  mode: Mode;
  media: MediaInfo;
  audio: AudioStream | undefined;
  start: number;
  length: number;
};

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

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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
  if (resolve(output) === resolve(input)) throw new Error('Результат не может заменить исходный файл.');
  if (taken(output)) throw new Error('Файл уже существует. Выберите другое имя.');
  let parent;
  try {
    parent = statSync(dirname(output));
  } catch {
    throw new Error('Каталог для результата не существует.');
  }
  if (!parent.isDirectory()) throw new Error('Каталог для результата не существует.');
  return output;
}

/** The tone map converts HDR10 or HLG into SDR BT.709. SDR sources get only a pixel format change. */
export function videoFilter(media: MediaInfo): string {
  const filters: string[] = [];
  if (media.video.width > maxWidth || media.video.height > maxHeight) {
    // Level 4.1 allows at most 1080p. Keep the aspect ratio and even dimensions.
    filters.push(`scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  if (media.video.hdr) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  filters.push('format=yuv420p');
  return filters.join(',');
}

export function audioCopied(plan: Pick<Plan, 'mode' | 'audio'>): boolean {
  return plan.mode.method === 'remux' && plan.audio !== undefined && copyAudio.has(plan.audio.codec);
}

/** Make the FFmpeg arguments. Paths are absolute and use the file: prefix, so FFmpeg cannot read them as options. */
export function ffmpegArgs(plan: Plan, target: string): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-n'];
  if (plan.mode.sample) args.push('-ss', String(plan.start));
  args.push('-protocol_whitelist', 'file', '-format_whitelist', inputFormats, '-i', `file:${plan.input}`);
  if (plan.mode.sample) args.push('-t', String(plan.length));
  args.push('-map', `0:${plan.media.video.index}`);
  if (plan.audio) args.push('-map', `0:${plan.audio.index}`);
  args.push('-sn', '-dn', '-map_chapters', '-1');
  if (plan.mode.method === 'remux') {
    args.push('-c:v', 'copy');
    // Apple players and Chromecast expect the hvc1 tag for HEVC in MP4.
    if (plan.media.video.codec === 'hevc') args.push('-tag:v', 'hvc1');
    args.push('-avoid_negative_ts', 'make_zero');
  } else {
    args.push('-vf', videoFilter(plan.media));
    args.push('-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-level:v', '4.1', '-b:v', String(videoBitrate), '-pix_fmt', 'yuv420p');
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv');
  }
  if (!plan.audio) args.push('-an');
  else if (audioCopied(plan)) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', String(audioBitrate), '-ac', '2');
  args.push('-movflags', '+faststart', '-f', 'mp4', `file:${target}`);
  return args;
}

/** Rough result size for the free space check. */
export function estimateSize(plan: Plan): number {
  const duration = plan.media.duration > 0 ? plan.media.duration : 0;
  const seconds = plan.mode.sample ? Math.min(plan.length, Math.max(0, duration - plan.start)) : Math.max(0, duration - plan.start);
  if (plan.mode.method === 'remux') return duration > 0 ? Math.ceil((plan.media.size * seconds) / duration) : plan.media.size;
  return Math.ceil(((videoBitrate + audioBitrate) / 8) * seconds * 1.1);
}
