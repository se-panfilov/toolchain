import { spawn } from 'node:child_process';
import { linkSync, lstatSync, mkdtempSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { toolEnvironment, type Tools } from '@reCast/media';
import { extractArgs, ffmpegArgs, type Plan, subtitleFile, subtitlePath, uniquePath } from '@reCast/plan';

export type Progress = { seconds: number; total: number; speed: number; done: boolean };
export type Result = { output: string; subtitles: string | undefined; renamed: boolean; interrupted: boolean };
const errorTail = 8192;
const progressLimit = 65536;

/** Free space in bytes at the destination directory, or NaN when the volume does not report it. */
export function freeSpace(directory: string): number {
  try {
    const stats = statfsSync(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return NaN;
  }
}

/** Read one block of `-progress` output. FFmpeg ends each block with a progress= line. */
export function parseProgress(block: string, total: number): Progress | undefined {
  const values = new Map<string, string>();
  for (const line of block.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const state = values.get('progress');
  if (!state) return undefined;
  const micro = Number(values.get('out_time_us') ?? values.get('out_time_ms'));
  const speed = Number.parseFloat(values.get('speed') ?? '');
  return { seconds: Number.isFinite(micro) && micro > 0 ? micro / 1e6 : 0, total, speed: Number.isFinite(speed) ? speed : 0, done: state === 'end' };
}

/**
 * Put the finished file in place without replacement of an existing file.
 * A hard link fails when the name is in use. Some volumes, such as exFAT, have no hard links. Then a rename after a check is used.
 */
export function placeResult(temporary: string, wanted: string): { output: string; renamed: boolean } {
  let output = wanted;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      linkSync(temporary, output);
      return { output, renamed: output !== wanted };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        output = uniquePath(wanted);
        continue;
      }
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw error;
      try {
        lstatSync(output);
        output = uniquePath(wanted);
        continue;
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      }
      renameSync(temporary, output);
      return { output, renamed: output !== wanted };
    }
  }
  throw new Error('Не удалось сохранить результат: имя файла занято.');
}

type Run = { status: number | null; interrupted: boolean; errors: string };

/**
 * Run FFmpeg in the private working directory. Ctrl+C reaches FFmpeg from the terminal.
 * The handler keeps this process alive until FFmpeg stops, so the cleanup can run.
 */
async function run(tools: Tools, args: string[], cwd: string, total: number, onProgress?: (progress: Progress) => void): Promise<Run> {
  const child = spawn(tools.ffmpeg, args, { cwd, env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let interrupted = false;
  const stop = (): void => {
    interrupted = true;
    child.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let buffer = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let end;
    while ((end = buffer.search(/progress=\w+\n/)) !== -1) {
      const next = buffer.indexOf('\n', end) + 1;
      const progress = parseProgress(buffer.slice(0, next), total);
      buffer = buffer.slice(next);
      if (progress) onProgress?.(progress);
    }
    // Progress blocks are short. Drop unexpected output without a block end.
    if (buffer.length > progressLimit) buffer = '';
  });
  child.stderr.on('data', (chunk: string) => {
    errors = (errors + chunk).slice(-errorTail);
  });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        resolve(code);
      });
    });
    return { status, interrupted, errors };
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function failure(result: Run): Error {
  const detail = result.errors.trim().split('\n').slice(-5).join('\n');
  return new Error(`FFmpeg завершился с ошибкой (код ${result.status ?? 'сигнал'}).${detail ? `\n${detail}` : ''}`);
}

/**
 * Convert into a private temporary directory next to the result. A failure or an interruption removes the partial files.
 * A text subtitle for burn-in is extracted first. FFmpeg reads it by a relative name, so no path goes into the filter graph.
 */
export async function convert(tools: Tools, plan: Plan, onProgress: (progress: Progress) => void): Promise<Result> {
  let workspace: string;
  try {
    workspace = mkdtempSync(join(dirname(plan.output), '.recast-'));
  } catch (error) {
    throw new Error(`Нет доступа на запись в каталог результата: ${(error as NodeJS.ErrnoException).code ?? 'ошибка'}.`, { cause: error });
  }
  const temporary = join(workspace, basename(plan.output));
  const temporarySubtitles = subtitlePath(temporary);
  const total = plan.mode.sample ? Math.min(plan.length, Math.max(0, plan.media.duration - plan.start)) : plan.media.duration;
  const stopped = { output: plan.output, subtitles: undefined, renamed: false, interrupted: true };
  try {
    const extract = extractArgs(plan, join(workspace, subtitleFile));
    if (extract) {
      const extracted = await run(tools, extract, workspace, 0);
      if (extracted.interrupted) return stopped;
      if (extracted.status !== 0) throw failure(extracted);
    }
    const converted = await run(tools, ffmpegArgs(plan, temporary, temporarySubtitles), workspace, total, onProgress);
    if (converted.interrupted) return stopped;
    if (converted.status !== 0) throw failure(converted);
    const placed = placeResult(temporary, plan.output);
    let subtitles: string | undefined;
    if (plan.subtitle?.format === 'vtt') subtitles = placeResult(temporarySubtitles, subtitlePath(placed.output)).output;
    return { ...placed, subtitles, interrupted: false };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
