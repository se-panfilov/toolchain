import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  assetDirectory,
  betaNotice,
  checkFile,
  checkOutputDirectory,
  createOutputDirectory,
  type FileKind,
  type Mode,
  outputStem,
  pandocArguments,
  type PandocContext,
  parseMode,
  placeFile,
  profiles,
  resolveFormats,
  type Target,
  targetState,
  writeBetaInput
} from '@eBook/book';
import {
  type BookMetadata,
  defaultLanguage,
  defaultRights,
  fieldProblem,
  isIsoDate,
  isSemver,
  localDate,
  type MetadataChanges,
  type MetadataFields,
  newIdentifier,
  parseMetadata,
  readMetadataText,
  renderMetadata,
  updateMetadataFile,
  updateMetadataText,
  writeNewFile
} from '@eBook/metadata';
import type { Asker, TerminalStyle } from '@eBook/prompts';
import { findEpubcheck, findPandoc, lastLines, type Pandoc, run, runChecked } from '@eBook/tools';

export type Say = (text: string, tone?: keyof TerminalStyle) => void;
/** Result lines for stdout. In the mode without questions, stdout has only result paths. */
export type Emit = (line: string) => void;

export type InitOptions = {
  metadata: string | undefined;
  title: string | undefined;
  author: string | undefined;
  lang: string | undefined;
  description: string | undefined;
  rights: string | undefined;
  yes: boolean;
  dryRun: boolean;
};

export type BuildOptions = {
  input: string | undefined;
  metadata: string | undefined;
  output: string | undefined;
  cover: string | undefined;
  referenceDoc: string | undefined;
  css: string | undefined;
  formats: string | undefined;
  mode: string | undefined;
  bookVersion: string | undefined;
  bookDate: string | undefined;
  overwrite: boolean;
  yes: boolean;
  dryRun: boolean;
};

export const defaultMetadata = 'metadata.yaml';
export const defaultOutput = 'build';

/** Ask until the check accepts the answer. The rejected answer stays in the field for editing. */
async function askValid(ask: Asker, question: string, initial: string, check: (value: string) => string | undefined, say: Say): Promise<string> {
  let value = initial;
  for (;;) {
    value = await ask.text(question, value);
    const problem = check(value);
    if (!problem) return value;
    say(problem, 'warning');
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileCheck(kind: FileKind, optional: boolean): (value: string) => string | undefined {
  return (value) => {
    if (optional && value === '') return undefined;
    if (value === '') return 'Укажите путь.';
    try {
      checkFile(resolve(value), kind);
      return undefined;
    } catch (error) {
      return errorText(error);
    }
  };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const initQuestions: { name: keyof MetadataFields; question: string }[] = [
  { name: 'title', question: 'Название книги' },
  { name: 'author', question: 'Автор' },
  { name: 'lang', question: 'Язык (код BCP 47)' },
  { name: 'description', question: 'Описание (можно оставить пустым)' },
  { name: 'rights', question: 'Права' }
];

/** Create metadata.yaml. Return its path, or undefined when the user cancels or for a dry-run. */
export async function runInit(options: InitOptions, ask: Asker | undefined, say: Say, emit: Emit, cwd = process.cwd()): Promise<string | undefined> {
  const target = resolve(cwd, options.metadata ?? defaultMetadata);
  if (exists(target)) throw new Error(`Файл уже существует: ${target}. Существующий файл не перезаписывается.`);
  const defaults: MetadataFields = { title: '', author: '', lang: defaultLanguage, description: '', rights: defaultRights };
  const fields: MetadataFields = { ...defaults };
  for (const { name, question } of initQuestions) {
    const given = options[name];
    if (given !== undefined) {
      const value = given.trim();
      const problem = fieldProblem(name, value);
      if (problem) throw new Error(problem);
      fields[name] = value;
    } else if (ask) {
      fields[name] = await askValid(ask, question, defaults[name], (value) => fieldProblem(name, value), say);
    } else {
      const problem = fieldProblem(name, defaults[name]);
      if (problem) throw new Error(`${problem} Укажите --${name}.`);
    }
  }
  const identifier = newIdentifier();
  const text = renderMetadata(fields, identifier);
  say(`Файл: ${target}`, 'strong');
  say(`  Название:   ${fields.title}`);
  say(`  Автор:      ${fields.author}`);
  say(`  Язык:       ${fields.lang}`);
  say(`  Identifier: ${identifier}`, 'muted');
  if (options.dryRun) {
    say('Dry-run: файл не создан. Содержимое:', 'success');
    say(text);
    return undefined;
  }
  if (ask && !(await ask.confirm('Создать файл?', true))) {
    say('Отменено.');
    return undefined;
  }
  writeNewFile(target, text);
  say('✓ metadata.yaml создан. Дата и версия запрашиваются при сборке.', 'success');
  if (!ask) emit(target);
  return target;
}

/** A single Markdown file in the directory is a useful default. */
export function defaultInput(cwd: string): string {
  try {
    const files = readdirSync(cwd, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name) && !/^readme\./i.test(entry.name));
    return files.length === 1 && files[0] ? files[0].name : '';
  } catch {
    return '';
  }
}

export function defaultCover(cwd: string): string {
  return ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'].find((name) => exists(join(cwd, name))) ?? '';
}

/** Show a command for the user. Arguments are quoted, so spaces and quotes stay visible. */
export function printable(tool: string, args: readonly string[]): string {
  return [tool, ...args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

type Resolved = {
  input: string;
  metadata: string;
  output: string;
  cover: string | undefined;
  css: string;
  referenceDoc: string;
  targets: Target[];
  mode: Mode;
};

async function resolveFiles(options: BuildOptions, ask: Asker | undefined, say: Say, emit: Emit, cwd: string, pandoc: Pandoc): Promise<Resolved | undefined> {
  let inputValue = options.input;
  if (inputValue === undefined && ask) inputValue = await askValid(ask, 'Исходный файл Markdown', defaultInput(cwd), fileCheck('input', false), say);
  if (inputValue === undefined || inputValue === '') throw new Error('Укажите исходный файл Markdown.');
  const input = checkFile(resolve(cwd, inputValue), 'input');

  let metadata = resolve(cwd, options.metadata ?? defaultMetadata);
  if (!exists(metadata)) {
    if (!ask) throw new Error(`Нет файла метаданных: ${metadata}. Создайте его командой tx-ebook init или укажите --metadata.`);
    say(`Нет файла метаданных: ${metadata}`, 'warning');
    if (!(await ask.confirm('Создать metadata.yaml сейчас?', true))) return undefined;
    const created = await runInit({ metadata, title: undefined, author: undefined, lang: undefined, description: undefined, rights: undefined, yes: false, dryRun: false }, ask, say, emit, cwd);
    if (!created) return undefined;
    metadata = created;
  }

  let formats = options.formats;
  if (formats === undefined && ask) {
    const chosen = await ask.checkbox(
      'Форматы',
      profiles.map((item) => ({ label: item.label, checked: true }))
    );
    formats = chosen.map((index) => profiles[index]?.key ?? '').join(',');
  }
  const targets = resolveFormats(formats ?? profiles.map((item) => item.key).join(','), pandoc.writers);

  let modeValue = options.mode;
  if (modeValue === undefined && ask) modeValue = (await ask.select('Тип сборки', ['Beta — с пометкой черновика', 'Production — финальная'], 0)) === 0 ? 'beta' : 'production';
  const mode = parseMode(modeValue ?? 'beta');

  const epub = targets.some((item) => item.kind === 'epub');
  let coverValue = options.cover;
  if (coverValue === undefined && ask && epub) coverValue = await askValid(ask, 'Обложка EPUB (пусто — без обложки)', defaultCover(cwd), fileCheck('cover', true), say);
  const cover = coverValue ? checkFile(resolve(cwd, coverValue), 'cover') : undefined;
  if (!cover && epub) say('Обложка не указана. EPUB будет без обложки.', 'warning');

  const assets = assetDirectory();
  const usesCss = targets.some((item) => item.kind === 'epub' || item.kind === 'html');
  const usesDocx = targets.some((item) => item.kind === 'docx');
  let cssValue = options.css;
  let referenceValue = options.referenceDoc;
  const askCss = cssValue === undefined && usesCss;
  const askReference = referenceValue === undefined && usesDocx;
  if (ask && (askCss || askReference) && (await ask.select('Оформление', ['Встроенное', 'Свои файлы'], 0)) === 1) {
    if (askCss) cssValue = await askValid(ask, 'Файл CSS для EPUB и HTML (пусто — встроенный)', '', fileCheck('css', true), say);
    if (askReference) referenceValue = await askValid(ask, 'Шаблон reference.docx (пусто — встроенный)', '', fileCheck('referenceDoc', true), say);
  }
  const css = checkFile(cssValue ? resolve(cwd, cssValue) : join(assets, 'epub.css'), 'css');
  const referenceDoc = checkFile(referenceValue ? resolve(cwd, referenceValue) : join(assets, 'reference.docx'), 'referenceDoc');

  let outputValue = options.output;
  if (outputValue === undefined && ask) outputValue = await askValid(ask, 'Выходной каталог', defaultOutput, (value) => (value === '' ? 'Укажите каталог.' : undefined), say);
  const output = resolve(cwd, outputValue ?? defaultOutput);
  checkOutputDirectory(output);
  return { input, metadata, output, cover, css, referenceDoc, targets, mode };
}

function readMetadata(pandoc: Pandoc, path: string, dataDir: string): BookMetadata {
  const result = runChecked(
    pandoc.path,
    [`--data-dir=${dataDir}`, '--from=markdown', '--to=json', `--metadata-file=${path}`],
    { cwd: dirname(path), input: '', timeout: 60000 },
    'Pandoc не смог прочитать метаданные'
  );
  return parseMetadata(result.stdout);
}

/** Version and date: from options, from questions, or from the file. Values change only through this step. */
async function resolveChanges(options: BuildOptions, ask: Asker | undefined, say: Say, meta: BookMetadata): Promise<{ version: string; date: string; changes: MetadataChanges }> {
  let version = options.bookVersion;
  if (version === undefined && ask)
    version = await askValid(ask, 'Версия книги', meta.version || '0.1.0', (value) => (isSemver(value) ? undefined : 'Нужна версия SemVer, например 1.2.3 или 1.2.3-beta.1.'), say);
  version ??= meta.version;
  if (!version) throw new Error('В metadata.yaml пустое поле version. Укажите --book-version, например 0.1.0.');
  if (!isSemver(version)) throw new Error(`Некорректная версия книги: ${version}. Нужен формат SemVer, например 1.2.3.`);

  let date = options.bookDate;
  if (date === undefined && ask) date = await askValid(ask, 'Дата книги (ГГГГ-ММ-ДД)', meta.date || localDate(), (value) => (isIsoDate(value) ? undefined : 'Нужна дата в формате ГГГГ-ММ-ДД.'), say);
  date ??= meta.date;
  if (!date) throw new Error('В metadata.yaml пустое поле date. Укажите --book-date в формате ГГГГ-ММ-ДД.');
  if (!isIsoDate(date)) throw new Error(`Некорректная дата книги: ${date}. Нужен формат ГГГГ-ММ-ДД.`);

  const changes: MetadataChanges = {};
  // A new version also replaces ibooks.version. An unchanged version keeps a mismatch, and the check reports it.
  if (version !== meta.version) changes.version = version;
  if (date !== meta.date) changes.date = date;
  return { version, date, changes };
}

function checkMetadata(meta: BookMetadata): void {
  if (!meta.title) throw new Error('В metadata.yaml нет title.');
  if (!meta.identifiers.length) throw new Error('В metadata.yaml нет identifier. Добавьте его, например urn:uuid:… (tx-ebook init создаёт его сам).');
  if (meta.empty.length) throw new Error(`Пустые поля в metadata.yaml: ${meta.empty.join(', ')}. Заполните их или удалите.`);
}

/** Build the book. Return the result paths. */
export async function runBuild(options: BuildOptions, ask: Asker | undefined, say: Say, emit: Emit, cwd = process.cwd()): Promise<string[]> {
  const pandoc = findPandoc(cwd);
  say(`Pandoc ${pandoc.version.join('.')}: ${pandoc.path}`, 'muted');
  const files = await resolveFiles(options, ask, say, emit, cwd, pandoc);
  if (!files) {
    say('Отменено.');
    return [];
  }
  // A private directory keeps the temporary input, metadata copies, and unfinished results.
  const work = mkdtempSync(join(tmpdir(), 'tx-ebook-'));
  // Ctrl+C reaches Pandoc too. Without this handler, Node.js would stop before the cleanup.
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  try {
    const dataDir = join(work, 'data');
    mkdirSync(dataDir, { mode: 0o700 });

    // Validate a copy, so that the checked text is the text that the build and the update use.
    const original = readMetadataText(files.metadata);
    const sourceCopy = join(work, 'source-metadata.yaml');
    writeFileSync(sourceCopy, original, { flag: 'wx', mode: 0o600 });
    const before = readMetadata(pandoc, sourceCopy, dataDir);
    if (!before.title) throw new Error('В metadata.yaml нет title.');
    const { version, date, changes } = await resolveChanges(options, ask, say, before);
    const changed = changes.version !== undefined || changes.date !== undefined;
    const buildMetadata = join(work, 'metadata.yaml');
    writeFileSync(buildMetadata, changed ? updateMetadataText(original, changes) : original, { flag: 'wx', mode: 0o600 });
    const meta = changed ? readMetadata(pandoc, buildMetadata, dataDir) : before;
    checkMetadata(meta);
    if (meta.ibooksVersion !== undefined && meta.ibooksVersion !== version) throw new Error(`ibooks.version (${meta.ibooksVersion}) не совпадает с version (${version}).`);

    const stem = outputStem(meta.title, version, files.mode);
    const plan = files.targets.map((target) => ({
      target,
      output: join(files.output, `${stem}.${target.extension}`),
      temporary: join(work, `result-${target.key.replace(/[^a-z0-9]/g, '_')}.${target.extension}`)
    }));
    // A result must never replace an input of the same build.
    const inputs = new Set([files.input, files.metadata, files.css, files.referenceDoc, files.cover].filter((path) => path !== undefined).map((path) => realpathSync(path)));
    for (const item of plan)
      if (inputs.has(item.output) || (exists(item.output) && inputs.has(realpathSync(item.output)))) throw new Error(`Файл результата совпадает с входным файлом: ${item.output}`);
    const existing = plan.filter((item) => targetState(item.output) === 'file');

    say('');
    say(meta.title, 'strong');
    say(`  Исходник:   ${files.input}`);
    say(`  Метаданные: ${files.metadata}`);
    say(`  Версия:     ${version}${changes.version !== undefined ? ` (было: ${before.version || 'пусто'})` : ''}`);
    say(`  Дата:       ${date}${changes.date !== undefined ? ` (было: ${before.date || 'пусто'})` : ''}`);
    say(`  Сборка:     ${files.mode}`);
    say(`  Обложка:    ${files.cover ?? 'нет'}`);
    say(`  Каталог:    ${files.output}`);
    for (const item of plan) say(`  ${item.target.label.padEnd(5)} → ${item.output}${existing.includes(item) ? ' (будет перезаписан)' : ''}`);
    if (changed) say('  metadata.yaml получит новые version/date после успешной сборки.', 'muted');

    let overwrite = options.overwrite;
    if (existing.length && !overwrite) {
      if (!ask || options.dryRun) {
        if (!options.dryRun) throw new Error('Файлы результата уже существуют. Используйте --overwrite или другой --output.');
        say('Файлы результата уже существуют. Для сборки нужен --overwrite.', 'warning');
      } else if (await ask.confirm('Перезаписать существующие файлы?', false)) overwrite = true;
      else {
        say('Отменено.');
        return [];
      }
    }

    const buildDate = localDate();
    const input = files.mode === 'beta' ? join(work, 'beta-input.md') : files.input;
    const context: PandocContext = {
      dataDir,
      metadata: buildMetadata,
      filter: join(assetDirectory(), 'scene-breaks.lua'),
      css: files.css,
      referenceDoc: files.referenceDoc,
      cover: files.cover,
      mode: files.mode,
      resourcePath: dirname(files.input),
      input
    };
    if (options.dryRun) {
      for (const item of plan) say(`[dry-run] ${printable('pandoc', pandocArguments(item.target, context, item.output))}`, 'muted');
      say('Dry-run: книга не собрана, файлы не изменены.', 'success');
      return [];
    }
    if (ask && !(await ask.confirm('Собрать книгу?', true))) {
      say('Отменено.');
      return [];
    }

    if (files.mode === 'beta') writeBetaInput(files.input, betaNotice(meta.title, version, buildDate, meta.lang), work);
    for (const item of plan) {
      say(`Сборка ${item.target.label}…`, 'accent');
      const result = run(pandoc.path, pandocArguments(item.target, context, item.temporary), { cwd: dirname(files.input) });
      if (interrupted || result.signal) throw new Error('Сборка прервана. Файлы результата не изменены.');
      if (result.stderr.trim()) say(lastLines(result.stderr, 20), 'muted');
      if (result.status !== 0) throw new Error(`Pandoc завершился с кодом ${String(result.status)} для ${item.target.label}. Файлы результата не изменены.`);
    }

    const epubcheck = plan.some((item) => item.target.extension === 'epub') ? findEpubcheck() : undefined;
    for (const item of plan.filter((entry) => entry.target.extension === 'epub')) {
      if (!epubcheck) {
        say('EPUBCheck не найден, проверка EPUB пропущена. Установка: brew install epubcheck', 'warning');
        break;
      }
      say(`EPUBCheck ${item.target.label}…`, 'accent');
      let result;
      try {
        result = run(epubcheck, [item.temporary], { cwd: work });
      } catch (error) {
        // EPUBCheck is optional. A tool that cannot start gives a warning, as a missing tool does.
        say(`${errorText(error)}\nПроверка EPUB пропущена.`, 'warning');
        break;
      }
      if (interrupted || result.signal) throw new Error('Проверка прервана. Файлы результата не изменены.');
      const report = lastLines(`${result.stdout}\n${result.stderr}`, 30);
      if (result.status !== 0) throw new Error(`EPUBCheck нашёл ошибки. Файлы результата не изменены.\n${report}`);
      if (report) say(report, 'muted');
    }

    createOutputDirectory(files.output);
    for (const item of plan) placeFile(item.temporary, item.output, overwrite);
    if (changed) {
      updateMetadataFile(files.metadata, original, changes);
      say(`metadata.yaml обновлён: ${[changes.version !== undefined ? `version ${version}` : '', changes.date !== undefined ? `date ${date}` : ''].filter(Boolean).join(', ')}.`, 'muted');
    }
    say('✓ Готово', 'success');
    for (const item of plan) {
      if (ask) say(`  ${item.output}`);
      else emit(item.output);
    }
    return plan.map((item) => item.output);
  } finally {
    process.removeListener('SIGINT', onSignal);
    rmSync(work, { recursive: true, force: true });
  }
}
