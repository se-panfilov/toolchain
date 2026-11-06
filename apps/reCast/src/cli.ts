#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { convert, freeSpace, type Progress } from '@reCast/convert';
import { type AudioStream, findTools, hasComponent, type MediaInfo, probe, type SubtitleStream, type Tools } from '@reCast/media';
import {
  audioCopied,
  availableModes,
  defaultAudio,
  defaultOutput,
  defaultStart,
  estimateSize,
  findMode,
  formatTime,
  type Mode,
  modes,
  parseDroppedPath,
  parseTime,
  type Plan,
  sampleLength,
  type SubtitleChoice,
  type SubtitleFormat,
  subtitleFormats,
  subtitlePath,
  usableSubtitles,
  validateOutput,
  validateStart
} from '@reCast/plan';
import { PromptCancelled, TerminalPrompts, type TerminalStyle, terminalStyle } from '@reCast/prompts';

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
Запуск: tx-recast [ФАЙЛ] [параметры]

  ФАЙЛ                    Исходное видео (MKV, MP4, MOV, AVI, TS).
  --mode РЕЖИМ            remux-test, remux, h264-test или h264.
  --audio N|none          Аудиодорожка по номеру из списка или без звука.
  --subtitles N|none      Субтитры по номеру из списка или без субтитров.
  --subtitle-format ВИД   vtt — отдельный файл .vtt, burn — вшить (только H.264).
  --start ВРЕМЯ           Начало тестового фрагмента: ЧЧ:ММ:СС или секунды.
  --output ПУТЬ           Путь к результату .mp4.
  --dry-run               Показать план без конвертации.
  -y, --yes               Без вопросов: нужны ФАЙЛ и --mode, остальное по умолчанию.
  --version               Версия.
  --help                  Справка.

Без --yes программа спрашивает то, что не задано параметрами.
С --yes вопросов нет, TTY не нужен, пути результатов выводятся в stdout.
Исходный файл не изменяется. Существующие файлы не перезаписываются.
Подробности: README.md пакета.`);
}
function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'неизвестно';
}

export type Arguments = {
  input: string | undefined;
  mode: string | undefined;
  audio: string | undefined;
  subtitles: string | undefined;
  subtitleFormat: string | undefined;
  start: string | undefined;
  output: string | undefined;
  yes: boolean;
  dryRun: boolean;
};
const valueOptions = { '--mode': 'mode', '--audio': 'audio', '--subtitles': 'subtitles', '--subtitle-format': 'subtitleFormat', '--start': 'start', '--output': 'output' } as const;
type ValueOption = keyof typeof valueOptions;
function isValueOption(name: string): name is ValueOption {
  return Object.hasOwn(valueOptions, name);
}

/** Read the arguments. Accept `--name value` and `--name=value`. Reject repeated, unknown, and empty options. */
export function parseArguments(args: string[]): Arguments {
  const result: Arguments = { input: undefined, mode: undefined, audio: undefined, subtitles: undefined, subtitleFormat: undefined, start: undefined, output: undefined, yes: false, dryRun: false };
  const seen = new Set<string>();
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options || !arg.startsWith('-')) {
      if (result.input !== undefined) throw new Error('Укажите один файл.');
      result.input = arg;
      continue;
    }
    const at = arg.indexOf('=');
    const name = at === -1 ? arg : arg.slice(0, at);
    const canonical = name === '-y' ? '--yes' : name;
    if (seen.has(canonical)) throw new Error(`Параметр указан повторно: ${name}`);
    seen.add(canonical);
    if (isValueOption(name)) {
      const value = at === -1 ? args[++i] : arg.slice(at + 1);
      if (value === undefined || value === '' || (at === -1 && value.startsWith('--'))) throw new Error(`Нет значения для ${name}.`);
      result[valueOptions[name]] = value;
    } else if (at === -1 && canonical === '--yes') result.yes = true;
    else if (at === -1 && name === '--dry-run') result.dryRun = true;
    else throw new Error(`Неизвестный параметр: ${name}. Используйте --help.`);
  }
  if (result.subtitleFormat !== undefined && (result.subtitles === undefined || result.subtitles === 'none')) throw new Error('--subtitle-format требует --subtitles N.');
  if (result.yes && (result.input === undefined || result.mode === undefined)) throw new Error('С --yes укажите ФАЙЛ и --mode.');
  return result;
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
export function audioLabel(stream: AudioStream, position: number): string {
  const parts = [`#${position + 1}`, stream.language || 'und', stream.codec, channels(stream.channels)];
  if (stream.title) parts.push(stream.title);
  return parts.join(' · ');
}
export function subtitleLabel(stream: SubtitleStream, position: number): string {
  const parts = [`#${position + 1}`, stream.language || 'und', stream.codec, stream.kind === 'text' ? 'текст' : 'изображения'];
  if (stream.forced) parts.push('принудительные');
  if (stream.title) parts.push(stream.title);
  return parts.join(' · ');
}
const formatLabels: Record<SubtitleFormat, string> = { vtt: 'Отдельный файл WebVTT (.vtt) — можно включать и выключать', burn: 'Вшить в видео — видны всегда, на любом устройстве' };

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

/** Pick a stream by its number in the shown list. */
function byNumber<T>(items: readonly T[], value: string, name: string): T {
  if (!/^[1-9]\d{0,3}$/.test(value)) throw new Error(`${name}: укажите номер из списка или none.`);
  const item = items[Number(value) - 1];
  if (item === undefined) throw new Error(`${name}: нет номера ${value}. В файле ${items.length}.`);
  return item;
}

/** Resolve the plan from options, terminal answers, or defaults. Only the answers that the options do not give are asked. */
export async function resolvePlan(input: string, media: MediaInfo, options: Arguments, prompts: TerminalPrompts | undefined, print: Printer): Promise<Plan> {
  const choices = availableModes(media);
  let mode: Mode | undefined;
  if (options.mode !== undefined) {
    mode = findMode(options.mode);
    if (!choices.includes(mode)) throw new Error(`Режим ${mode.id} недоступен: кодек ${media.video.codec} требует перекодирования.`);
  } else if (prompts) {
    if (choices.length < modes.length) print(`REMUX недоступен: кодек ${media.video.codec} требует перекодирования.`, 'warning');
    const labels = choices.map((item) => `${item.label}${item.method === 'h264' && media.video.hdr ? ', HDR → SDR' : ''}`);
    mode = choices[await prompts.select('Что сделать?', labels, 0)];
  }
  if (!mode) throw new Error('Режим не выбран. Укажите --mode.');
  if (options.start !== undefined && !mode.sample) throw new Error('--start допустим только для режимов remux-test и h264-test.');

  let audio: AudioStream | undefined = media.audio[defaultAudio(media)];
  if (options.audio === 'none') audio = undefined;
  else if (options.audio !== undefined) audio = byNumber(media.audio, options.audio, '--audio');
  else if (prompts && media.audio.length > 1) audio = media.audio[await prompts.select('Аудиодорожка', media.audio.map(audioLabel), defaultAudio(media))];

  let subtitle: SubtitleChoice | undefined;
  if (options.subtitles !== undefined && options.subtitles !== 'none') {
    const stream = byNumber(media.subtitles, options.subtitles, '--subtitles');
    const formats = subtitleFormats(mode, stream);
    if (!formats.length) throw new Error('Субтитры из изображений можно только вшить, а это требует режима H.264.');
    const format = (options.subtitleFormat ?? formats[0]) as SubtitleFormat;
    if (!formats.includes(format)) throw new Error(`--subtitle-format: допустимо ${formats.join(' или ')} для этих субтитров и режима.`);
    subtitle = { stream, format };
  } else if (options.subtitles === undefined && prompts) {
    const usable = usableSubtitles(media, mode);
    if (media.subtitles.length > usable.length) print('Субтитры из изображений можно только вшить в режиме H.264.', 'muted');
    if (usable.length) {
      const labels = ['Без субтитров', ...usable.map((stream) => subtitleLabel(stream, media.subtitles.indexOf(stream)))];
      const stream = usable[(await prompts.select('Субтитры', labels, 0)) - 1];
      if (stream) {
        const formats = subtitleFormats(mode, stream);
        const format =
          formats.length > 1
            ? formats[
                await prompts.select(
                  'Как добавить субтитры?',
                  formats.map((item) => formatLabels[item]),
                  0
                )
              ]
            : formats[0];
        if (format) subtitle = { stream, format };
      }
    }
  }

  let start = 0;
  if (mode.sample) {
    start = defaultStart(media.duration);
    if (options.start !== undefined) start = validateStart(parseTime(options.start), media.duration);
    else if (prompts) {
      let initial = formatTime(start);
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
  }

  let output = defaultOutput(input, mode);
  if (options.output !== undefined) output = validateOutput(resolve(options.output), input);
  else if (prompts) {
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
  } else validateOutput(output, input);

  return { input, output, mode, media, audio, subtitle, start, length: mode.sample ? sampleLength : media.duration };
}

type Printer = (value: unknown, tone?: keyof TerminalStyle) => void;
function printer(stream: NodeJS.WriteStream): Printer {
  const colors = terminalStyle(stream);
  return (value, tone = 'plain') => {
    stream.write(`${colors[tone](safe(value))}\n`);
  };
}

function describe(media: MediaInfo, print: Printer): void {
  const video = media.video;
  const indent = '\n             ';
  print(`  Видео:     ${video.codec} · ${video.width}×${video.height}${video.hdr ? ` · HDR (${video.transfer})` : ''}`);
  print(`  Аудио:     ${media.audio.length ? media.audio.map(audioLabel).join(indent) : 'нет'}`);
  print(`  Субтитры:  ${media.subtitles.length ? media.subtitles.map(subtitleLabel).join(indent) : 'нет'}`);
  print(`  Длина:     ${media.duration > 0 ? formatTime(media.duration) : 'неизвестна'} · ${size(media.size)}`);
}

function summary(plan: Plan, print: Printer): void {
  const { media, mode } = plan;
  print('');
  print(`  Режим:     ${mode.label}`);
  if (mode.sample) print(`  Фрагмент:  ${formatTime(plan.start)} + ${Math.round(media.duration > 0 ? Math.min(sampleLength, media.duration - plan.start) : sampleLength)} с`);
  if (plan.audio) print(`  Аудио:     ${audioLabel(plan.audio, media.audio.indexOf(plan.audio))} → ${audioCopied(plan) ? 'без изменений' : 'AAC стерео'}`);
  else print('  Аудио:     нет');
  if (plan.subtitle) {
    const label = subtitleLabel(plan.subtitle.stream, media.subtitles.indexOf(plan.subtitle.stream));
    print(`  Субтитры:  ${label} → ${plan.subtitle.format === 'vtt' ? subtitlePath(plan.output) : 'вшиты в видео'}`);
  } else print('  Субтитры:  нет');
  print(`  Результат: ${plan.output}`);
}

async function askInput(prompts: TerminalPrompts, initial: string | undefined, print: Printer): Promise<string> {
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
function existingInput(value: string): string {
  const path = resolve(value);
  try {
    if (!statSync(path).isFile()) throw new Error();
    return realpathSync(path);
  } catch {
    throw new Error(`Файл не найден: ${path}`);
  }
}

function checkEncoder(tools: Tools, plan: Plan): void {
  if (plan.mode.method !== 'h264') return;
  if (!hasComponent(tools, 'encoders', 'h264_videotoolbox')) throw new Error('В этой сборке FFmpeg нет h264_videotoolbox.');
  if (plan.media.video.hdr && !hasComponent(tools, 'filters', 'zscale')) throw new Error('В этой сборке FFmpeg нет фильтра zscale. Попробуйте: brew reinstall ffmpeg');
  if (plan.subtitle?.format === 'burn' && plan.subtitle.stream.kind === 'text' && !hasComponent(tools, 'filters', 'subtitles')) {
    throw new Error('В этой сборке FFmpeg нет фильтра subtitles (libass). Попробуйте: brew reinstall ffmpeg');
  }
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
  // Without questions, stdout gets only the result paths. Messages go to stderr.
  const unattended = options.yes;
  if (!unattended && (!stdin.isTTY || !stdout.isTTY)) throw new Error('Нужен интерактивный терминал (TTY) или параметр --yes.');
  const messages = unattended ? process.stderr : stdout;
  const say = printer(messages);
  const colors = terminalStyle(messages);
  const tools = findTools();
  say('reCast · видео для Chromecast', 'accent');
  say(`FFmpeg: ${tools.ffmpeg}`, 'muted');
  const prompts = unattended ? undefined : new TerminalPrompts();
  try {
    const input = prompts ? await askInput(prompts, options.input, say) : existingInput(options.input ?? '');
    const media = probe(tools, input);
    say(input, 'strong');
    describe(media, say);
    const plan = await resolvePlan(input, media, options, prompts, say);
    checkEncoder(tools, plan);
    summary(plan, say);
    const needed = estimateSize(plan);
    const free = freeSpace(dirname(plan.output));
    say(`  Размер:    ≈ ${size(needed)}${Number.isFinite(free) ? ` · свободно ${size(free)}` : ''}`, 'muted');
    if (options.dryRun) {
      say('Dry-run: конвертация не выполнялась, файлы не созданы.', 'success');
      return;
    }
    if (needed > free) {
      say('Свободного места может не хватить.', 'warning');
      if (!prompts) throw new Error('Недостаточно свободного места. Освободите место или выберите другой каталог.');
      if (!(await prompts.confirm('Всё равно начать?', false))) {
        say('Отменено.');
        return;
      }
    } else if (prompts && !(await prompts.confirm('Начать?', true))) {
      say('Отменено.');
      return;
    }

    // Draw progress only on a terminal. A pipe or a log file gets no control sequences.
    const width = messages.columns || 80;
    let drawn = false;
    const result = await convert(tools, plan, (progress) => {
      if (!messages.isTTY) return;
      messages.write(`\r\x1b[2K${colors.accent(progressLine(progress, width))}`);
      drawn = true;
    });
    if (drawn) messages.write('\n');
    if (result.interrupted) {
      say('Прервано. Незавершённые файлы удалены.', 'warning');
      process.exitCode = 130;
      return;
    }
    say('✓ Готово', 'success');
    if (result.renamed) say('Имя было занято во время конвертации. Файл сохранён под другим именем.', 'warning');
    if (unattended) {
      stdout.write(`${safe(result.output)}\n`);
      if (result.subtitles) stdout.write(`${safe(result.subtitles)}\n`);
      return;
    }
    say(`  ${result.output}`);
    if (result.subtitles) say(`  ${result.subtitles}`);
    // Show the result in Finder. A failure here does not affect the result.
    spawnSync('/usr/bin/open', ['-R', result.output], { stdio: 'ignore', timeout: 10000 });
  } finally {
    prompts?.close();
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
