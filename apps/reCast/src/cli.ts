#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { convert, freeSpace, type Progress } from '@reCast/convert';
import { findTools, hasComponent, type MediaInfo, probe, type Tools } from '@reCast/media';
import {
  audioCopied,
  availableModes,
  defaultAudio,
  defaultOutput,
  defaultStart,
  estimateSize,
  formatTime,
  parseDroppedPath,
  parseTime,
  type Plan,
  sampleLength,
  validateOutput,
  validateStart
} from '@reCast/plan';
import { PromptCancelled, TerminalPrompts, terminalStyle } from '@reCast/prompts';

// File names and FFmpeg messages can contain terminal control characters.
function safe(value: unknown): string {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' ? ch : '?'));
}
const style = terminalStyle();
function print(value: unknown, tone: keyof ReturnType<typeof terminalStyle> = 'plain'): void {
  console.log(style[tone](safe(value)));
}
function help(): void {
  print(`reCast — подготовка видео к трансляции на Chromecast и другие устройства.
macOS, Node.js 24.12+, FFmpeg (brew install ffmpeg).
Запуск: tx-recast [ФАЙЛ]

  ФАЙЛ        Исходное видео (MKV, MP4, MOV, AVI, TS). Без него путь спросят.
  --version   Версия.
  --help      Справка.

Режимы:
  REMUX       Перепаковка в MP4 без перекодирования видео. Только H.264 и HEVC.
  H.264       Аппаратное кодирование (VideoToolbox), до 1080p, HDR → SDR.
  Тест        Фрагмент 60 с для проверки на устройстве.

Исходный файл не изменяется. Результат — новый MP4 рядом с исходным файлом.
Существующие файлы не перезаписываются. Подробности: README.md пакета.`);
}
function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'неизвестно';
}

export type Arguments = { input: string | undefined };
export function parseArguments(args: string[]): Arguments {
  let input: string | undefined;
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') options = false;
    else if (options && arg.startsWith('-')) throw new Error(`Неизвестный параметр: ${arg}. Используйте --help.`);
    else if (input !== undefined) throw new Error('Укажите один файл.');
    else input = arg;
  }
  return { input };
}

export function checkRuntime(platform = process.platform, node = process.versions.node): void {
  const [major = 0, minor = 0] = node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) throw new Error('Требуется Node.js 24.12 или новее.');
  if (platform !== 'darwin') throw new Error('reCast пока поддерживает только macOS.');
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`;
}
function channels(count: number): string {
  return count === 1 ? 'моно' : count === 2 ? 'стерео' : count === 6 ? '5.1' : count === 8 ? '7.1' : `${count} кан.`;
}
export function audioLabel(stream: MediaInfo['audio'][number], position: number): string {
  const parts = [`#${position + 1}`, stream.language || 'und', stream.codec, channels(stream.channels)];
  if (stream.title) parts.push(stream.title);
  return parts.join(' · ');
}

function describe(media: MediaInfo): void {
  const video = media.video;
  print(`  Видео:     ${video.codec} · ${video.width}×${video.height}${video.hdr ? ` · HDR (${video.transfer})` : ''}`);
  print(`  Аудио:     ${media.audio.length ? media.audio.map(audioLabel).join('\n             ') : 'нет'}`);
  print(`  Длина:     ${media.duration > 0 ? formatTime(media.duration) : 'неизвестна'} · ${size(media.size)}`);
  if (media.subtitles) print(`  Субтитры:  ${media.subtitles} — в результат не входят`, 'muted');
}

/** Draw one progress line. Use the terminal width, so the line never wraps. */
export function progressLine(progress: Progress, width: number): string {
  const ratio = progress.total > 0 ? Math.min(1, progress.seconds / progress.total) : 0;
  const percent = progress.done ? 100 : Math.floor(ratio * 100);
  const left = progress.speed > 0 && progress.total > 0 ? (progress.total - progress.seconds) / progress.speed : NaN;
  const details = [`${String(percent).padStart(3)}%`, `${formatTime(progress.done ? progress.total : progress.seconds)} / ${formatTime(progress.total)}`];
  if (progress.speed > 0) details.push(`${progress.speed.toFixed(1)}x`);
  if (Number.isFinite(left) && !progress.done) details.push(`осталось ${formatTime(left)}`);
  const text = details.join(' · ');
  const bar = Math.max(10, Math.min(30, width - text.length - 6));
  const filled = Math.round((progress.done ? 1 : ratio) * bar);
  return `  ${'█'.repeat(filled)}${'░'.repeat(bar - filled)} ${text}`;
}

async function askInput(prompts: TerminalPrompts, initial: string | undefined): Promise<string> {
  let value = initial;
  for (;;) {
    const raw = value ?? (await prompts.text('Путь к видео (можно перетащить файл в окно)'));
    value = undefined;
    if (!raw) continue;
    const path = parseDroppedPath(raw);
    try {
      if (!statSync(path).isFile()) throw new Error();
      return realpathSync(path);
    } catch {
      print(`Файл не найден: ${path}`, 'error');
    }
  }
}

function checkEncoder(tools: Tools, media: MediaInfo): void {
  if (!hasComponent(tools, 'encoders', 'h264_videotoolbox')) throw new Error('В этой сборке FFmpeg нет h264_videotoolbox.');
  if (media.video.hdr && !hasComponent(tools, 'filters', 'zscale')) throw new Error('В этой сборке FFmpeg нет фильтра zscale. Попробуйте: brew reinstall ffmpeg');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0] ?? '')) {
    help();
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
    console.log(version());
    return;
  }
  const options = parseArguments(args);
  checkRuntime();
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Нужен интерактивный терминал (TTY).');
  const tools = findTools();
  print('reCast · видео для Chromecast', 'accent');
  print(`FFmpeg: ${tools.ffmpeg}`, 'muted');
  const prompts = new TerminalPrompts();
  try {
    const input = await askInput(prompts, options.input);
    const media = probe(tools, input);
    print(input, 'strong');
    describe(media);

    const choices = availableModes(media);
    if (choices.length < 4) print(`REMUX недоступен: кодек ${media.video.codec} требует перекодирования.`, 'warning');
    const mode =
      choices[
        await prompts.select(
          'Что сделать?',
          choices.map((item) => `${item.label}${item.method === 'h264' && media.video.hdr ? ', HDR → SDR' : ''}`),
          0
        )
      ];
    if (!mode) throw new Error('Режим не выбран.');
    if (mode.method === 'h264') checkEncoder(tools, media);

    let audio = media.audio[0];
    if (media.audio.length > 1) audio = media.audio[await prompts.select('Аудиодорожка', media.audio.map(audioLabel), defaultAudio(media))];

    let start = 0;
    if (mode.sample) {
      let initial = formatTime(defaultStart(media.duration));
      for (;;) {
        const value = await prompts.text('Начало фрагмента', initial);
        try {
          start = validateStart(parseTime(value), media.duration);
          break;
        } catch (error) {
          initial = value;
          print(error instanceof Error ? error.message : String(error), 'error');
        }
      }
    }

    let output = defaultOutput(input, mode);
    for (;;) {
      const value = await prompts.text('Сохранить как', output);
      try {
        output = validateOutput(parseDroppedPath(value), input);
        break;
      } catch (error) {
        output = value;
        print(error instanceof Error ? error.message : String(error), 'error');
      }
    }

    const plan: Plan = { input, output, mode, media, audio, start, length: mode.sample ? sampleLength : media.duration };
    print('');
    print(`  Режим:     ${mode.label}`);
    if (mode.sample) print(`  Фрагмент:  ${formatTime(start)} + ${Math.round(media.duration > 0 ? Math.min(sampleLength, media.duration - start) : sampleLength)} с`);
    if (audio) print(`  Аудио:     ${audioLabel(audio, media.audio.indexOf(audio))} → ${audioCopied(plan) ? 'без изменений' : 'AAC стерео'}`);
    else print('  Аудио:     нет');
    print(`  Результат: ${output}`);
    const needed = estimateSize(plan);
    const free = freeSpace(dirname(output));
    print(`  Размер:    ≈ ${size(needed)}${Number.isFinite(free) ? ` · свободно ${size(free)}` : ''}`, 'muted');
    if (needed > free) {
      print('Свободного места может не хватить.', 'warning');
      if (!(await prompts.confirm('Всё равно начать?', false))) {
        print('Отменено.');
        return;
      }
    } else if (!(await prompts.confirm('Начать?', true))) {
      print('Отменено.');
      return;
    }

    const width = stdout.columns || 80;
    let drawn = false;
    const result = await convert(tools, plan, (progress) => {
      stdout.write(`\r\x1b[2K${style.accent(progressLine(progress, width))}`);
      drawn = true;
    });
    if (drawn) stdout.write('\n');
    if (result.interrupted) {
      print('Прервано. Незавершённый файл удалён.', 'warning');
      process.exitCode = 130;
      return;
    }
    print('✓ Готово', 'success');
    if (result.renamed) print('Имя было занято во время конвертации. Файл сохранён под другим именем.', 'warning');
    print(`  ${result.output}`);
    // Show the result in Finder. A failure here does not affect the result.
    spawnSync('/usr/bin/open', ['-R', result.output], { stdio: 'ignore', timeout: 10000 });
  } finally {
    prompts.close();
  }
}

// An npm bin can be a symbolic link. Compare the real paths.
let entry = '';
try {
  if (process.argv[1]) entry = pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  /* Import from stdin or eval. */
}
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    if (error instanceof PromptCancelled) {
      print('Отменено.', 'muted');
      process.exitCode = 130;
    } else {
      console.error(style.error(safe(`Ошибка: ${error instanceof Error ? error.message : String(error)}`)));
      process.exitCode = 1;
    }
  });
}
