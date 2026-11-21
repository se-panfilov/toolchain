import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const defaultLanguage = 'ru-RU';
export const defaultRights = 'Unpublished manuscript. All rights reserved.';
export const metadataLimit = 1024 * 1024;

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const languagePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const uuidPattern = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Control, format, and line separator characters can break YAML or terminal output.
const unsafeText = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** User-visible characters. Emoji sequences and combined letters count as one character. */
export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

export function isSemver(value: string): boolean {
  return value.length <= 64 && semverPattern.test(value);
}

/** A calendar date in the YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function isLanguageTag(value: string): boolean {
  return value.length <= 35 && languagePattern.test(value);
}

export function localDate(now = new Date()): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * EPUB 3 requires a unique dc:identifier that stays the same between revisions of the book.
 * Without an ISBN or DOI, a random UUID in the urn:uuid form is the usual value.
 */
export function newIdentifier(): string {
  return `urn:uuid:${randomUUID()}`;
}

export function isUuidIdentifier(value: string): boolean {
  return uuidPattern.test(value);
}

export type MetadataFields = { title: string; author: string; lang: string; description: string; rights: string };
type FieldName = keyof MetadataFields;
const fieldLimits: Record<FieldName, number> = { title: 500, author: 500, lang: 35, description: 4000, rights: 1000 };
const fieldNames: Record<FieldName, string> = { title: 'Название', author: 'Автор', lang: 'Язык', description: 'Описание', rights: 'Права' };

/** Check one value for the new metadata file. Return a Russian error text, or undefined for a valid value. */
export function fieldProblem(name: FieldName, value: string): string | undefined {
  const label = fieldNames[name];
  if (unsafeText.test(value)) return `${label}: управляющие символы и переводы строк недопустимы.`;
  if (graphemes(value).length > fieldLimits[name]) return `${label}: не длиннее ${fieldLimits[name]} символов.`;
  if ((name === 'title' || name === 'author') && value === '') return `${label}: обязательное поле.`;
  if (name === 'lang' && !isLanguageTag(value)) return `${label}: нужен код языка, например ru-RU или en-US.`;
  return undefined;
}

// A JSON string is a valid YAML double-quoted scalar. The input has no control or line separator characters.
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Make the metadata.yaml text. Empty optional fields stay as comments, because Pandoc writes
 * empty EPUB elements for empty values. The build asks for date and version later.
 */
export function renderMetadata(fields: MetadataFields, identifier: string): string {
  for (const name of Object.keys(fieldLimits) as FieldName[]) {
    const problem = fieldProblem(name, fields[name]);
    if (problem) throw new Error(problem);
  }
  if (!isUuidIdentifier(identifier)) throw new Error('Некорректный identifier.');
  const optional = (name: string, value: string): string => (value === '' ? `# ${name}: ""` : `${name}: ${quote(value)}`);
  return [
    `title: ${quote(fields.title)}`,
    '# subtitle: ""',
    '',
    'creator:',
    '  - role: author',
    `    text: ${quote(fields.author)}`,
    '',
    `lang: ${quote(fields.lang)}`,
    '',
    'date: ""',
    'version: ""',
    '',
    optional('description', fields.description),
    '',
    'subject: []',
    '',
    optional('rights', fields.rights),
    '',
    'identifier:',
    '  - scheme: URN',
    `    text: ${quote(identifier)}`,
    '',
    'ibooks:',
    '  version: ""',
    ''
  ].join('\n');
}

/** Create a new file. Never replace an existing file or follow a link at the target path. */
export function writeNewFile(path: string, content: string): void {
  let directory = false;
  try {
    directory = statSync(dirname(path)).isDirectory();
  } catch {
    /* Reported below. */
  }
  if (!directory) throw new Error(`Каталог не найден: ${dirname(path)}`);
  // The wx flag uses O_EXCL: the call fails if a file or a link is at the path, also a dangling link.
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Файл уже существует: ${path}. Существующий файл не перезаписывается.`, { cause: error });
    throw error;
  }
}

// Pandoc JSON metadata values.
type MetaValue = { t?: unknown; c?: unknown };
function isMeta(value: unknown): value is MetaValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inlineText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item: unknown): string => {
      if (!isMeta(item)) return '';
      const content = item.c;
      switch (item.t) {
        case 'Str':
          return typeof content === 'string' ? content : '';
        case 'Space':
        case 'SoftBreak':
        case 'LineBreak':
          return ' ';
        case 'Code':
          return Array.isArray(content) && typeof content[1] === 'string' ? content[1] : '';
        case 'Emph':
        case 'Strong':
        case 'SmallCaps':
        case 'Strikeout':
        case 'Superscript':
        case 'Subscript':
        case 'Underline':
          return inlineText(content);
        case 'Quoted': {
          if (!Array.isArray(content)) return '';
          const double = isMeta(content[0]) && content[0].t === 'DoubleQuote';
          return `${double ? '“' : '‘'}${inlineText(content[1])}${double ? '”' : '’'}`;
        }
        case 'Link':
        case 'Image':
        case 'Span':
          return Array.isArray(content) ? inlineText(content[1]) : '';
        default:
          return '';
      }
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text of a scalar metadata value. Lists join their items. */
export function metaText(value: unknown): string {
  if (!isMeta(value)) return '';
  switch (value.t) {
    case 'MetaString':
      return typeof value.c === 'string' ? value.c.trim() : '';
    case 'MetaInlines':
      return inlineText(value.c);
    case 'MetaBlocks':
      return Array.isArray(value.c)
        ? value.c
            .map((block: unknown) => (isMeta(block) && (block.t === 'Para' || block.t === 'Plain') ? inlineText(block.c) : ''))
            .filter(Boolean)
            .join(' ')
        : '';
    case 'MetaBool':
      return value.c === true ? 'true' : 'false';
    case 'MetaList':
      return Array.isArray(value.c) ? value.c.map(metaText).filter(Boolean).join(' ') : '';
    default:
      return '';
  }
}

function mapOf(value: unknown): Record<string, unknown> | undefined {
  return isMeta(value) && value.t === 'MetaMap' && isMeta(value.c) ? value.c : undefined;
}

/** Paths of text values without content, such as `subtitle` or `creator[1].text`. */
export function emptyFields(meta: Record<string, unknown>): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (!isMeta(value)) return;
    const map = mapOf(value);
    if (map) {
      for (const [key, item] of Object.entries(map)) visit(item, `${path}.${key}`);
    } else if (value.t === 'MetaList' && Array.isArray(value.c)) {
      value.c.forEach((item: unknown, index) => {
        visit(item, `${path}[${String(index + 1)}]`);
      });
    } else if (value.t !== 'MetaBool' && metaText(value) === '') found.push(path);
  };
  for (const [key, value] of Object.entries(meta)) visit(value, key);
  return found;
}

export type Identifier = { text: string; scheme: string };
export type BookMetadata = {
  title: string;
  version: string;
  ibooksVersion: string | undefined;
  date: string;
  lang: string;
  identifiers: Identifier[];
  empty: string[];
};

function identifiers(value: unknown): Identifier[] {
  const result: Identifier[] = [];
  const visit = (node: unknown): void => {
    if (!isMeta(node)) return;
    const map = mapOf(node);
    if (map) {
      const text = metaText(map.text);
      if (text) result.push({ text, scheme: metaText(map.scheme) });
    } else if (node.t === 'MetaList' && Array.isArray(node.c)) node.c.forEach(visit);
    else {
      const text = metaText(node);
      if (text) result.push({ text, scheme: '' });
    }
  };
  visit(value);
  return result;
}

/** Read the values that the build needs from Pandoc JSON output for the metadata file. */
export function parseMetadata(json: string): BookMetadata {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Pandoc вернул некорректный ответ при чтении метаданных.');
  }
  const meta = isMeta(data) && isMeta((data as { meta?: unknown }).meta) ? (data as { meta: Record<string, unknown> }).meta : {};
  let title = metaText(meta.title);
  // EPUB title lists use objects with `type: main`.
  if (isMeta(meta.title) && meta.title.t === 'MetaList' && Array.isArray(meta.title.c)) {
    const main = meta.title.c.map(mapOf).find((item) => item && metaText(item.type).toLowerCase().includes('main'));
    if (main) title = metaText(main.text);
  }
  const ibooks = mapOf(meta.ibooks);
  return {
    title,
    version: metaText(meta.version),
    ibooksVersion: ibooks && 'version' in ibooks ? metaText(ibooks.version) : undefined,
    date: metaText(meta.date),
    lang: metaText(meta.lang ?? meta.language),
    identifiers: identifiers(meta.identifier),
    empty: emptyFields(meta)
  };
}

export type MetadataChanges = { version?: string | undefined; date?: string | undefined };

/**
 * Replace the top-level version and date lines, and ibooks.version, in the YAML text.
 * The other lines and comments do not change. Throw when a required line is missing.
 */
export function updateMetadataText(source: string, changes: MetadataChanges): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  let version = false;
  let date = false;
  let inIbooks = false;
  let ibooksIndent = 0;
  const out = lines.map((line) => {
    if (changes.version !== undefined && /^version\s*:/.test(line)) {
      version = true;
      return `version: ${quote(changes.version)}`;
    }
    if (changes.date !== undefined && /^date\s*:/.test(line)) {
      date = true;
      return `date: ${quote(changes.date)}`;
    }
    const start = /^(\s*)ibooks\s*:\s*(#.*)?$/.exec(line);
    if (start) {
      inIbooks = true;
      ibooksIndent = start[1]?.length ?? 0;
      return line;
    }
    if (inIbooks) {
      const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
      if (line.trim() !== '' && !/^\s*#/.test(line) && indent <= ibooksIndent) inIbooks = false;
    }
    const nested = inIbooks ? /^(\s+)version\s*:/.exec(line) : null;
    if (nested && changes.version !== undefined) return `${nested[1] ?? ''}version: ${quote(changes.version)}`;
    return line;
  });
  if (changes.version !== undefined && !version) throw new Error('В metadata.yaml нет строки version: на верхнем уровне. Добавьте version: "".');
  if (changes.date !== undefined && !date) throw new Error('В metadata.yaml нет строки date: на верхнем уровне. Добавьте date: "".');
  return out.join(newline);
}

/** Read a metadata file for an update. Refuse links, because a rename would replace the link, not its target. */
function readForUpdate(path: string): { text: string; mode: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Метаданные должны быть обычным файлом: ${path}`);
    if (stat.nlink !== 1) throw new Error(`У файла метаданных есть жёсткие ссылки: ${path}. Обновление отменено.`);
    if (stat.size > metadataLimit) throw new Error(`Файл метаданных больше 1 МБ: ${path}`);
    return { text: readFileSync(fd, 'utf8'), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Write new version or date values atomically. A temporary file in the same directory replaces the
 * original after a check that nobody changed the file during the run.
 */
export function updateMetadataFile(path: string, expected: string, changes: MetadataChanges): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Файл метаданных — символическая ссылка: ${path}. Обновите версию и дату в исходном файле вручную.`);
  const current = readForUpdate(path);
  if (current.text !== expected) throw new Error(`Файл метаданных изменился во время работы: ${path}. Запустите программу снова.`);
  const next = updateMetadataText(current.text, changes);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, next, { encoding: 'utf8', flag: 'wx', mode: current.mode });
  try {
    if (readForUpdate(path).text !== expected) throw new Error(`Файл метаданных изменился во время работы: ${path}. Запустите программу снова.`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Read the metadata text for a later update check. The checks and the read use one file descriptor. */
export function readMetadataText(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Метаданные должны быть обычным файлом: ${path}`);
    if (stat.size > metadataLimit) throw new Error(`Файл метаданных больше 1 МБ: ${path}`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
