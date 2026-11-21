import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { graphemes } from '@reBook/metadata';

export type Kind = 'epub' | 'docx' | 'html' | 'other';
export type Target = { key: string; label: string; writer: string; extension: string; kind: Kind };
export type Mode = 'beta' | 'production';

export const profiles: readonly Target[] = [
  { key: 'epub', label: 'EPUB', writer: 'epub3', extension: 'epub', kind: 'epub' },
  { key: 'docx', label: 'DOCX', writer: 'docx', extension: 'docx', kind: 'docx' },
  { key: 'html', label: 'HTML', writer: 'html5', extension: 'html', kind: 'html' }
];
const aliases: Record<string, string> = { word: 'docx' };
const writerPattern = /^[a-z0-9][a-z0-9+.-]{0,31}$/;

export const limits = { input: 64 * 1024 * 1024, cover: 32 * 1024 * 1024, css: 1024 * 1024, referenceDoc: 32 * 1024 * 1024 };

/** File extension for a Pandoc writer that has no profile. */
export function writerExtension(writer: string): string | undefined {
  if (writer === 'epub2' || writer === 'epub3' || writer === 'epub') return 'epub';
  if (writer === 'html4' || writer === 'html5' || writer === 'html') return 'html';
  return /^[a-z0-9]{1,16}$/.test(writer) ? writer : undefined;
}

/**
 * Resolve a comma-separated format list. Profiles get tuned Pandoc options. Other Pandoc
 * writers are accepted only when the installed Pandoc lists them.
 */
export function resolveFormats(raw: string, writers: readonly string[]): Target[] {
  const available = new Set(writers);
  const targets: Target[] = [];
  const unknown: string[] = [];
  for (const token of raw.split(',')) {
    const name = token.trim().toLowerCase();
    if (!name) continue;
    const normalized = aliases[name] ?? name;
    const profile = profiles.find((item) => item.key === normalized || item.writer === normalized);
    if (profile) {
      if (!available.has(profile.writer)) unknown.push(name);
      else if (!targets.some((item) => item.key === profile.key)) targets.push(profile);
      continue;
    }
    const extension = writerPattern.test(normalized) ? writerExtension(normalized) : undefined;
    if (!extension || !available.has(normalized)) {
      unknown.push(name);
      continue;
    }
    if (!targets.some((item) => item.key === normalized)) targets.push({ key: normalized, label: normalized, writer: normalized, extension, kind: 'other' });
  }
  if (unknown.length) throw new Error(`Неизвестный формат: ${unknown.join(', ')}. Доступно: epub, docx, html и другие форматы Pandoc.`);
  if (!targets.length) throw new Error('Не выбран ни один формат.');
  const extensions = targets.map((item) => item.extension);
  if (new Set(extensions).size !== extensions.length) throw new Error('Два формата дают файлы с одинаковым расширением. Выберите один из них.');
  return targets;
}

export function parseMode(value: string): Mode {
  const mode = value.trim().toLowerCase();
  if (mode === 'beta') return 'beta';
  if (mode === 'production' || mode === 'prod') return 'production';
  throw new Error('--mode: укажите beta или production.');
}

/** File name stem: title, beta mark, and version. Characters that file systems reject become `_`. */
export function outputStem(title: string, version: string, mode: Mode): string {
  let safe = title
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\:*?"<>|]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // Remove leading and trailing dots and spaces without a backtracking regular expression.
  let start = 0;
  let end = safe.length;
  while (start < end && (safe[start] === '.' || safe[start] === ' ')) start++;
  while (end > start && (safe[end - 1] === '.' || safe[end - 1] === ' ')) end--;
  safe = graphemes(safe.slice(start, end)).slice(0, 120).join('').trim();
  if (!safe) safe = 'book';
  const parts = [safe];
  if (mode === 'beta') parts.push('beta');
  if (version) parts.push(version.replace(/[.+]/g, '_'));
  return parts.join(' - ');
}

/** Directory with the default Lua filter, CSS, and reference.docx. It works from dist/src and from src. */
export function assetDirectory(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [join(here, '..', '..', 'assets'), join(here, '..', 'assets')]) {
    try {
      if (statSync(join(candidate, 'scene-breaks.lua')).isFile()) return realpathSync(candidate);
    } catch {
      /* Try the next location. */
    }
  }
  throw new Error('Не найдены встроенные файлы оформления (assets). Переустановите пакет.');
}

function head(path: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export type FileKind = 'input' | 'cover' | 'css' | 'referenceDoc';
const fileLabels: Record<FileKind, string> = { input: 'Исходный файл', cover: 'Обложка', css: 'Файл CSS', referenceDoc: 'Шаблон DOCX' };
const coverExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Image formats that EPUB 3 readers support, by file signature. */
export function isCoverImage(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return true;
  const ascii = bytes.toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return true;
  return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
}

/** Check a file that Pandoc reads. Return its real path. A link is accepted, because the file is only read. */
export function checkFile(path: string, kind: FileKind): string {
  const label = fileLabels[kind];
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`${label} не найден: ${path}`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${label} должен быть обычным файлом: ${path}`);
  if (stat.size > limits[kind]) throw new Error(`${label} больше ${String(Math.round(limits[kind] / 1024 / 1024))} МБ: ${path}`);
  if (stat.size === 0) throw new Error(`${label} пустой: ${path}`);
  const extension = extname(real).toLowerCase();
  if (kind === 'cover' && (!coverExtensions.has(extension) || !isCoverImage(head(real, 16)))) throw new Error(`${label}: нужен файл JPEG, PNG, GIF или WebP: ${path}`);
  if (kind === 'referenceDoc' && (extension !== '.docx' || !head(real, 4).equals(Buffer.from('PK\x03\x04', 'latin1')))) throw new Error(`${label}: нужен файл .docx: ${path}`);
  if (kind === 'css' && (extension !== '.css' || head(real, 4096).includes(0))) throw new Error(`${label}: нужен текстовый файл .css: ${path}`);
  if (kind === 'input' && head(real, 4096).includes(0)) throw new Error(`${label}: нужен текстовый файл Markdown: ${path}`);
  return real;
}

export type PandocContext = {
  dataDir: string;
  metadata: string;
  filter: string;
  css: string;
  referenceDoc: string;
  cover: string | undefined;
  mode: Mode;
  resourcePath: string;
  input: string;
};

/**
 * Pandoc arguments for one format. Options use the `--name=value` form, and the input follows `--`,
 * so a path never becomes an option. The private data directory keeps user templates, defaults,
 * and init.lua out of the build.
 */
export function pandocArguments(target: Target, context: PandocContext, output: string): string[] {
  const args = [`--data-dir=${context.dataDir}`, `--metadata-file=${context.metadata}`, `--resource-path=${context.resourcePath}`, `--lua-filter=${context.filter}`];
  if (target.kind === 'epub') {
    args.push('--to=epub3', '--split-level=1', `--css=${context.css}`);
    if (context.cover) args.push(`--epub-cover-image=${context.cover}`);
    if (context.mode === 'beta') args.push('--epub-title-page=false');
  } else if (target.kind === 'docx') {
    args.push('--to=docx', `--reference-doc=${context.referenceDoc}`);
  } else if (target.kind === 'html') {
    args.push('--to=html5', '--standalone', '--embed-resources', `--css=${context.css}`);
  } else {
    args.push(`--to=${target.writer}`);
  }
  args.push(`--output=${output}`, '--', context.input);
  return args;
}

/** Text of the beta notice at the start of the book. The language follows the book. */
export function betaNotice(title: string, version: string, date: string, lang: string): string {
  const russian = /^ru\b/i.test(lang);
  const escaped = title.replace(/[\\`*_{}[\]()#+\-.!<>|~^$@"']/g, '\\$&');
  return [
    '::: {.beta-notice}',
    `**${escaped}**`,
    '',
    version ? `Beta ${version}` : 'Beta',
    '',
    date,
    '',
    russian ? 'Черновая версия для бета-чтения.' : 'Draft version for beta readers.',
    russian ? 'Пожалуйста, не распространять.' : 'Please do not distribute.',
    ':::',
    '',
    ''
  ].join('\n');
}

/** Write the beta input into the private work directory. The source file does not change. */
export function writeBetaInput(source: string, notice: string, workDir: string): string {
  const path = join(workDir, 'beta-input.md');
  writeFileSync(path, `${notice}${readFileSync(source, 'utf8')}`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Check the output directory. Return true when it exists. A link or a file at the path stops the build. */
export function checkOutputDirectory(path: string): boolean {
  const stat = lstatOrUndefined(path);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Выходной каталог не должен быть символической ссылкой: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Выходной путь не является каталогом: ${path}`);
  return true;
}

export function createOutputDirectory(path: string): void {
  if (checkOutputDirectory(path)) return;
  mkdirSync(path, { recursive: true, mode: 0o755 });
  checkOutputDirectory(path);
}

/** State of a result path: free, an existing regular file, or something that must not be replaced. */
export function targetState(path: string): 'free' | 'file' {
  const stat = lstatOrUndefined(path);
  if (!stat) return 'free';
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`По пути результата лежит не обычный файл: ${path}. Удалите его или выберите другой каталог.`);
  return 'file';
}

export type Placement = { source: string; target: string };

type Staged = { target: string; temporary: string; backup?: string; replaced?: boolean; created?: boolean };

function sameFile(left: string, right: string): boolean {
  try {
    const a = lstatSync(left);
    const b = lstatSync(right);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

function removeQuietly(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Undo the placed files in reverse order. Return the result paths that did not come back. */
function rollback(staged: readonly Staged[]): string[] {
  const failed: string[] = [];
  for (const entry of [...staged].reverse()) {
    try {
      if (entry.replaced && entry.backup) renameSync(entry.backup, entry.target);
      else if (entry.created && sameFile(entry.temporary, entry.target)) rmSync(entry.target);
      if (entry.backup) rmSync(entry.backup, { force: true });
    } catch {
      failed.push(entry.backup ? `${entry.target} (копия: ${entry.backup})` : entry.target);
    }
  }
  return failed;
}

/**
 * Put finished files into the output directory as one step. Each file goes into a temporary copy in
 * the target directory first. A replaced file gives its permission bits to the new file. A hard link
 * keeps each replaced file until the end. Without overwrite, a hard link creates the target only when
 * the name is free. `finish` runs when all files are in place. When a step or `finish` fails, the old
 * files come back and the new names are removed. Return the copies of old files that stayed on disk.
 */
export function placeFiles(items: readonly Placement[], overwrite: boolean, finish: () => void = () => undefined): string[] {
  const staged: Staged[] = [];
  const sibling = (target: string, suffix: string): string => join(dirname(target), `.${basename(target)}.${randomUUID()}.${suffix}`);
  try {
    for (const item of items) {
      const existing = targetState(item.target) === 'file';
      if (existing && !overwrite) throw new Error(`Файл уже существует: ${item.target}. Используйте --overwrite.`);
      const temporary = sibling(item.target, 'tmp');
      // A copy for a replaced file starts private and then gets the permission bits of that file.
      writeFileSync(temporary, readFileSync(item.source), { flag: 'wx', mode: existing ? 0o600 : 0o644 });
      staged.push({ target: item.target, temporary });
      if (existing) {
        const stat = lstatSync(item.target);
        if (!stat.isFile()) throw new Error(`По пути результата лежит не обычный файл: ${item.target}. Удалите его или выберите другой каталог.`);
        chmodSync(temporary, stat.mode & 0o777);
      }
    }
    for (const entry of staged) {
      if (overwrite && targetState(entry.target) === 'file') {
        entry.backup = sibling(entry.target, 'old');
        linkSync(entry.target, entry.backup);
        renameSync(entry.temporary, entry.target);
        entry.replaced = true;
      } else {
        try {
          linkSync(entry.temporary, entry.target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Файл появился во время сборки: ${entry.target}. Запустите сборку снова.`, { cause: error });
          throw error;
        }
        entry.created = true;
      }
    }
    finish();
  } catch (error) {
    const touched = staged.some((entry) => entry.replaced || entry.created);
    const failed = rollback(staged);
    const message = error instanceof Error ? error.message : String(error);
    if (failed.length) throw new Error(`${message}\nНе удалось вернуть прежнее состояние файлов результата:\n${failed.join('\n')}`, { cause: error });
    if (touched) throw new Error(`${message}\nПрежние файлы результата восстановлены.`, { cause: error });
    throw error;
  } finally {
    for (const entry of staged) removeQuietly(entry.temporary);
  }
  return staged.flatMap((entry) => (entry.backup && !removeQuietly(entry.backup) ? [entry.backup] : []));
}
