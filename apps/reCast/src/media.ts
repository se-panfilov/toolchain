import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Homebrew directories come first, as in Terminal and Finder starts on Apple silicon and Intel Macs. */
export const toolDirectories = ['/opt/homebrew/bin', '/usr/local/bin'];
/** Demuxers for usual video files. Playlists, concat lists, and network formats stay disabled. */
export const inputFormats = 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts';
const probeLimit = 16 * 1024 * 1024;

export type Tools = { ffmpeg: string; ffprobe: string };
export type VideoStream = { index: number; codec: string; width: number; height: number; pixelFormat: string; transfer: string; hdr: boolean };
export type AudioStream = { index: number; codec: string; channels: number; language: string; title: string; isDefault: boolean };
export type SubtitleStream = { index: number; codec: string; language: string; title: string; isDefault: boolean; forced: boolean; kind: 'text' | 'image' };
export type MediaInfo = { duration: number; size: number; container: string; video: VideoStream; audio: AudioStream[]; subtitles: SubtitleStream[] };

/** Text subtitles convert into WebVTT or render with libass. Image subtitles can only be burned in with an overlay. */
export const textSubtitles = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
export const imageSubtitles = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/**
 * Isolate FFmpeg from the user environment. Variables such as FFREPORT write extra files.
 * Tools start with absolute paths, so PATH contains only system directories.
 * HOME stays, because libass and fontconfig keep the font cache there for burned-in subtitles.
 */
export function toolEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', AV_LOG_FORCE_NOCOLOR: '1', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
}

function executable(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) return undefined;
    accessSync(real, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

/** Find FFmpeg and use FFprobe from the same directory. Mixed installations give inconsistent results. */
export function findTools(path = process.env.PATH ?? '', directories = toolDirectories): Tools {
  const candidates = [...directories, ...path.split(':').filter((entry) => isAbsolute(entry))];
  for (const directory of new Set(candidates)) {
    const ffmpeg = executable(join(directory, 'ffmpeg'));
    if (!ffmpeg) continue;
    const ffprobe = executable(join(dirname(ffmpeg), 'ffprobe'));
    if (ffprobe) return { ffmpeg, ffprobe };
  }
  throw new Error('FFmpeg не найден. Установите его: brew install ffmpeg');
}

function run(tool: string, args: string[]): string {
  const result = spawnSync(tool, args, { encoding: 'utf8', env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: probeLimit, timeout: 60000 });
  if (result.error) throw new Error(`Не удалось запустить ${tool}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim().split('\n').slice(-3).join('\n') || `${tool} завершился с кодом ${result.status}.`);
  return result.stdout;
}

/** Check the FFmpeg build for a hardware encoder or a filter. */
export function hasComponent(tools: Tools, kind: 'encoders' | 'filters', name: string): boolean {
  const output = run(tools.ffmpeg, ['-hide_banner', `-${kind}`]);
  return output.split('\n').some((line) => line.trim().split(/\s+/)[1] === name);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function number(value: unknown): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(result) ? result : 0;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** PQ (HDR10, Dolby Vision base layer) and HLG need tone mapping for SDR screens. */
export function isHdr(transfer: string): boolean {
  return transfer === 'smpte2084' || transfer === 'arib-std-b67';
}

/** Convert FFprobe JSON into the values the plan needs. Reject files without a usable video stream. */
export function parseProbe(json: string, size: number): MediaInfo {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('FFprobe вернул некорректный ответ.');
  }
  const root = record(data);
  const format = record(root.format);
  const streams = Array.isArray(root.streams) ? root.streams.map(record) : [];
  // Cover images in MKV and MP4 are video streams with the attached_pic disposition.
  const videoData = streams.find((stream) => stream.codec_type === 'video' && number(record(stream.disposition).attached_pic) !== 1);
  if (!videoData) throw new Error('В файле нет видеодорожки.');
  const transfer = text(videoData.color_transfer);
  const video: VideoStream = {
    index: number(videoData.index),
    codec: text(videoData.codec_name),
    width: number(videoData.width),
    height: number(videoData.height),
    pixelFormat: text(videoData.pix_fmt),
    transfer,
    hdr: isHdr(transfer)
  };
  const audio = streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream): AudioStream => {
      const tags = record(stream.tags);
      return {
        index: number(stream.index),
        codec: text(stream.codec_name),
        channels: number(stream.channels),
        language: text(tags.language),
        title: text(tags.title),
        isDefault: number(record(stream.disposition).default) === 1
      };
    });
  return {
    duration: number(format.duration),
    size,
    container: text(format.format_name),
    video,
    audio,
    subtitles: streams
      .filter((stream) => stream.codec_type === 'subtitle')
      .flatMap((stream): SubtitleStream[] => {
        const codec = text(stream.codec_name);
        const kind = textSubtitles.has(codec) ? 'text' : imageSubtitles.has(codec) ? 'image' : undefined;
        // Unknown subtitle codecs, such as teletext, are not offered.
        if (!kind) return [];
        const tags = record(stream.tags);
        const disposition = record(stream.disposition);
        return [
          { index: number(stream.index), codec, language: text(tags.language), title: text(tags.title), isDefault: number(disposition.default) === 1, forced: number(disposition.forced) === 1, kind }
        ];
      })
  };
}

/** Read stream data. The input is an absolute path, and the file: prefix blocks other protocols. */
export function probe(tools: Tools, input: string): MediaInfo {
  if (!isAbsolute(input)) throw new Error('Нужен абсолютный путь к файлу.');
  const size = statSync(input).size;
  const output = run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', inputFormats, '-print_format', 'json', '-show_format', '-show_streams', `file:${input}`]);
  return parseProbe(output, size);
}
