#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { type BuildOptions, defaultMetadata, type InitOptions, runBuild, runInit, type Say } from '@reBook/flows';
import { PromptCancelled, TerminalPrompts, terminalStyle } from '@reBook/prompts';

// Paths, titles, and Pandoc messages can contain terminal control characters.
export function safe(value: unknown): string {
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => (ch === '\n' ? ch : '?'));
}
const style = terminalStyle();
function print(value: unknown, tone: keyof ReturnType<typeof terminalStyle> = 'plain'): void {
  console.log(style[tone](safe(value)));
}

export const helpText = `reBook — сборка электронной книги из Markdown через Pandoc.
Node.js 24.12+, Pandoc 3.0+ (brew install pandoc). EPUBCheck — по желанию.

Запуск:
  tx-rebook                           Меню: сборка или создание metadata.yaml.
  tx-rebook build [ФАЙЛ] [параметры]  Собрать книгу из ФАЙЛА Markdown.
  tx-rebook init [параметры]          Создать metadata.yaml.

Параметры build:
  ФАЙЛ                      Исходный файл Markdown.
  --metadata ПУТЬ           Файл метаданных (по умолчанию metadata.yaml).
  --output КАТАЛОГ          Выходной каталог (по умолчанию build).
  --cover ПУТЬ              Обложка EPUB: JPEG, PNG, GIF или WebP.
  --css ПУТЬ                Свой CSS для EPUB и HTML вместо встроенного.
  --reference-doc ПУТЬ      Свой шаблон стилей DOCX вместо встроенного.
  --formats СПИСОК          Форматы через запятую: epub,docx,html (по умолчанию все три).
  --mode РЕЖИМ              beta (по умолчанию) или production.
  --book-version ВЕРСИЯ     Версия книги SemVer. Записывается в metadata.yaml.
  --book-date ДАТА          Дата книги ГГГГ-ММ-ДД. Записывается в metadata.yaml.
  --typograf-rules ПУТЬ     Файл правил типографирования (по умолчанию typograf.rules.json рядом с ФАЙЛОМ).
  --typograf-profile ПРОФИЛЬ  default или literary-markdown — профиль для нового файла правил.
  --overwrite               Перезаписать существующие файлы результата.

Параметры init:
  --metadata ПУТЬ           Новый файл (по умолчанию metadata.yaml).
  --title ТЕКСТ             Название книги.
  --author ТЕКСТ            Автор.
  --lang КОД                Язык (по умолчанию ru-RU).
  --description ТЕКСТ       Описание.
  --rights ТЕКСТ            Права (по умолчанию "Unpublished manuscript. All rights reserved.").

Общие параметры:
  --dry-run                 Показать план без записи файлов.
  -y, --yes                 Без вопросов. build требует ФАЙЛ, init — --title и --author.
  --version                 Версия программы.
  --help                    Справка.

Без --yes программа спрашивает то, что не задано параметрами.
С --yes вопросов нет, TTY не нужен, пути результатов выводятся в stdout.
Исходный файл не изменяется. Существующий metadata.yaml не перезаписывается.
Перед сборкой build типографирует ФАЙЛ через Typograf Core и сохраняет результат
рядом с ним как ФАЙЛ.formatted.md; этот файл и используется для EPUB/DOCX/HTML.
Он перезаписывается при каждой сборке и не зависит от --overwrite.
Подробности: README.md пакета.`;

function version(): string {
  for (const relative of ['../../package.json', '../package.json']) {
    const url = new URL(relative, import.meta.url);
    if (!existsSync(url)) continue;
    const manifest = JSON.parse(readFileSync(url, 'utf8')) as { name?: unknown; version?: unknown };
    if (manifest.name === 'tx-rebook' && typeof manifest.version === 'string') return manifest.version;
  }
  return 'неизвестно';
}

export type Command = { name: 'menu' } | { name: 'help' } | { name: 'version' } | { name: 'build'; options: BuildOptions } | { name: 'init'; options: InitOptions };

const buildValues = {
  '--metadata': 'metadata',
  '--output': 'output',
  '--cover': 'cover',
  '--css': 'css',
  '--reference-doc': 'referenceDoc',
  '--formats': 'formats',
  '--mode': 'mode',
  '--book-version': 'bookVersion',
  '--book-date': 'bookDate',
  '--typograf-rules': 'typografRules',
  '--typograf-profile': 'typografProfile'
} as const;
const initValues = { '--metadata': 'metadata', '--title': 'title', '--author': 'author', '--lang': 'lang', '--description': 'description', '--rights': 'rights' } as const;

export function emptyBuild(): BuildOptions {
  return {
    input: undefined,
    metadata: undefined,
    output: undefined,
    cover: undefined,
    referenceDoc: undefined,
    css: undefined,
    formats: undefined,
    mode: undefined,
    bookVersion: undefined,
    bookDate: undefined,
    typografRules: undefined,
    typografProfile: undefined,
    overwrite: false,
    yes: false,
    dryRun: false
  };
}
export function emptyInit(): InitOptions {
  return { metadata: undefined, title: undefined, author: undefined, lang: undefined, description: undefined, rights: undefined, yes: false, dryRun: false };
}

/**
 * Read the arguments. Accept `--name value` and `--name=value`. Reject repeated, unknown, and empty
 * options. A value that starts with `--` needs the `--name=value` form. Text values for init may be
 * empty only in the `--name=` form.
 */
export function parseArguments(args: readonly string[]): Command {
  if (args.length === 0) return { name: 'menu' };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { name: 'help' };
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) return { name: 'version' };
  const first = args[0];
  const name = first === 'init' ? 'init' : 'build';
  const rest = first === 'init' || first === 'build' ? args.slice(1) : args;
  const values: Record<string, string> = name === 'init' ? initValues : buildValues;
  const result: Record<string, string | boolean | undefined> = name === 'init' ? { ...emptyInit() } : { ...emptyBuild() };
  const seen = new Set<string>();
  let options = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options || !arg.startsWith('-') || arg === '-') {
      if (name === 'init') throw new Error(`Лишний аргумент: ${arg}. Используйте --help.`);
      if (result.input !== undefined) throw new Error('Укажите один исходный файл.');
      result.input = arg;
      continue;
    }
    const at = arg.indexOf('=');
    const option = at === -1 ? arg : arg.slice(0, at);
    const canonical = option === '-y' ? '--yes' : option;
    if (seen.has(canonical)) throw new Error(`Параметр указан повторно: ${option}`);
    seen.add(canonical);
    const key = Object.hasOwn(values, option) ? values[option] : undefined;
    if (key !== undefined) {
      const value = at === -1 ? rest[++i] : arg.slice(at + 1);
      const emptyAllowed = name === 'init' && at !== -1 && (option === '--description' || option === '--rights');
      if (value === undefined || (value === '' && !emptyAllowed) || (at === -1 && value.startsWith('--'))) throw new Error(`Нет значения для ${option}.`);
      result[key] = value;
    } else if (at === -1 && canonical === '--yes') result.yes = true;
    else if (at === -1 && option === '--dry-run') result.dryRun = true;
    else if (at === -1 && option === '--overwrite' && name === 'build') result.overwrite = true;
    else throw new Error(`Неизвестный параметр: ${option}. Используйте --help.`);
  }
  if (name === 'init') {
    const init = result as InitOptions;
    if (init.yes && (init.title === undefined || init.author === undefined)) throw new Error('С --yes для init укажите --title и --author.');
    return { name, options: init };
  }
  const build = result as BuildOptions;
  if (build.yes && build.input === undefined) throw new Error('С --yes укажите исходный ФАЙЛ.');
  return { name, options: build };
}

export function checkRuntime(node = process.versions.node): void {
  const [major = 0, minor = 0] = node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) throw new Error('Требуется Node.js 24.12 или новее.');
}

function printer(stream: NodeJS.WriteStream): Say {
  const colors = terminalStyle(stream);
  return (text, tone = 'plain') => {
    stream.write(`${colors[tone](safe(text))}\n`);
  };
}

async function main(): Promise<void> {
  const command = parseArguments(process.argv.slice(2));
  if (command.name === 'help') {
    print(helpText);
    return;
  }
  if (command.name === 'version') {
    console.log(version());
    return;
  }
  checkRuntime();
  const unattended = command.name !== 'menu' && command.options.yes;
  if (!unattended && (!stdin.isTTY || !stdout.isTTY)) throw new Error('Нужен интерактивный терминал (TTY) или параметр --yes.');
  // Without questions, stdout gets only the result paths. Messages go to stderr.
  const messages = unattended ? process.stderr : stdout;
  const say = printer(messages);
  const emit = (line: string): void => {
    stdout.write(`${safe(line)}\n`);
  };
  const prompts = unattended ? undefined : new TerminalPrompts();
  try {
    say('reBook · сборка книги', 'accent');
    if (command.name === 'init') {
      await runInit(command.options, prompts, say, emit);
      return;
    }
    if (command.name === 'build') {
      await runBuild(command.options, prompts, say, emit);
      return;
    }
    if (!prompts) throw new Error('Нужен интерактивный терминал (TTY).');
    const hasMetadata = existsSync(resolve(defaultMetadata));
    const choice = await prompts.select('Что сделать?', ['Собрать книгу', 'Создать metadata.yaml'], hasMetadata ? 0 : 1);
    if (choice === 1) await runInit(emptyInit(), prompts, say, emit);
    else await runBuild(emptyBuild(), prompts, say, emit);
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
