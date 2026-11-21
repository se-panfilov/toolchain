import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { writeNewFile } from '@reBook/metadata';
import Typograf from 'typograf';

export type TypografProfileName = 'default' | 'literary-markdown';
export type TypografWhitelist = { schemaVersion: number; locale: string; enabledRules: string[] };
/** `existing` means the file on disk was loaded as is. `generated` means this run wrote a new file. */
export type TypografSource = 'existing' | 'generated';
export type TypografConfig = { path: string; whitelist: TypografWhitelist; source: TypografSource };

export const defaultWhitelistName = 'typograf.rules.json';
export const schemaVersion = 1;
export const defaultLocale = 'ru';
// A whitelist is a short, hand-written list of rule names. A large file is not a valid whitelist.
const whitelistLimit = 256 * 1024;

/**
 * Rule names that Typograf Core 7.9.1 enables by default for the `common` and `ru` locales. A test
 * compares this list with `Typograf.getRules()` for the installed version, so an unnoticed dependency
 * change breaks the test instead of changing the profile in silence. This profile is not aware of
 * Markdown and can change text inside code blocks and links. See the README for the limitation.
 */
const defaultProfileRules: readonly string[] = [
  'common/html/quot',
  'common/nbsp/afterParagraphMark',
  'common/nbsp/afterSectionMark',
  'common/nbsp/afterShortWord',
  'common/nbsp/afterShortWordByList',
  'common/nbsp/beforeShortLastNumber',
  'common/nbsp/beforeShortLastWord',
  'common/nbsp/dpi',
  'common/nbsp/nowrap',
  'common/number/fraction',
  'common/number/mathSigns',
  'common/number/times',
  'common/other/delBOM',
  'common/punctuation/apostrophe',
  'common/punctuation/delDoublePunctuation',
  'common/punctuation/hellip',
  'common/punctuation/quote',
  'common/punctuation/quoteLink',
  'common/space/afterColon',
  'common/space/afterComma',
  'common/space/afterExclamationMark',
  'common/space/afterQuestionMark',
  'common/space/afterSemicolon',
  'common/space/beforeBracket',
  'common/space/bracket',
  'common/space/delBeforeDot',
  'common/space/delBeforePercent',
  'common/space/delBeforePunctuation',
  'common/space/delBetweenExclamationMarks',
  'common/space/delRepeatN',
  'common/space/delRepeatSpace',
  'common/space/delTrailingBlanks',
  'common/space/replaceTab',
  'common/space/squareBracket',
  'common/space/trimLeft',
  'common/space/trimRight',
  'common/symbols/arrow',
  'common/symbols/cf',
  'common/symbols/copy',
  'ru/dash/centuries',
  'ru/dash/daysMonth',
  'ru/dash/decade',
  'ru/dash/directSpeech',
  'ru/dash/izpod',
  'ru/dash/izza',
  'ru/dash/ka',
  'ru/dash/kakto',
  'ru/dash/koe',
  'ru/dash/main',
  'ru/dash/month',
  'ru/dash/surname',
  'ru/dash/taki',
  'ru/dash/time',
  'ru/dash/to',
  'ru/dash/weekday',
  'ru/dash/years',
  'ru/date/fromISO',
  'ru/date/weekday',
  'ru/nbsp/abbr',
  'ru/nbsp/addr',
  'ru/nbsp/afterNumberSign',
  'ru/nbsp/beforeParticle',
  'ru/nbsp/centuries',
  'ru/nbsp/dayMonth',
  'ru/nbsp/initials',
  'ru/nbsp/m',
  'ru/nbsp/mln',
  'ru/nbsp/ooo',
  'ru/nbsp/page',
  'ru/nbsp/ps',
  'ru/nbsp/rubleKopek',
  'ru/nbsp/see',
  'ru/nbsp/year',
  'ru/nbsp/years',
  'ru/number/comma',
  'ru/number/ordinals',
  'ru/other/phone-number',
  'ru/punctuation/ano',
  'ru/punctuation/exclamation',
  'ru/punctuation/exclamationQuestion',
  'ru/punctuation/hellipQuestion',
  'ru/space/afterHellip',
  'ru/space/year',
  'ru/symbols/NN',
  'ru/typo/switchingKeyboardLayout'
];

/**
 * A conservative whitelist for Russian fiction in Markdown. It fixes an ellipsis and the dash in a
 * small, closed list of Russian words, and removes a UTF-8 BOM. It never touches spaces, blank
 * lines, line breaks, Markdown or HTML syntax, or expressive punctuation, so a Markdown list marker
 * such as `- ` and an author's chosen punctuation stay untouched.
 */
const literaryMarkdownProfileRules: readonly string[] = [
  'common/other/delBOM',
  'common/punctuation/hellip',
  'ru/dash/izpod',
  'ru/dash/izza',
  'ru/dash/ka',
  'ru/dash/kakto',
  'ru/dash/koe',
  'ru/dash/taki',
  'ru/dash/to'
];

const profileRules: Record<TypografProfileName, readonly string[]> = {
  default: defaultProfileRules,
  'literary-markdown': literaryMarkdownProfileRules
};

/** Labels for the interactive profile choice. The prompt component owns the question text and the keys. */
export const profileLabels: Record<TypografProfileName, string> = {
  default: 'Стандартные правила Typograf',
  'literary-markdown': 'Художественная литература (Markdown)'
};

export function parseTypografProfile(value: string): TypografProfileName {
  const name = value.trim().toLowerCase();
  if (name === 'default' || name === 'literary-markdown') return name;
  throw new Error(`Неизвестный профиль типографирования: ${value}. Доступно: default, literary-markdown.`);
}

/** The full whitelist for a built-in profile, ready to write as `typograf.rules.json`. */
export function buildWhitelist(profile: TypografProfileName): TypografWhitelist {
  return { schemaVersion, locale: defaultLocale, enabledRules: [...profileRules[profile]] };
}

export function renderWhitelist(whitelist: TypografWhitelist): string {
  return `${JSON.stringify(whitelist, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check and parse a whitelist. Typograf Core does not reject an unknown rule name by itself, so this
 * function checks every name against `Typograf.getRule()`. A rule from another locale is also
 * rejected, because Typograf Core only applies an enabled rule when its own locale is active, and a
 * rule from an inactive locale would stay in the file without an effect.
 */
export function parseWhitelist(text: string): TypografWhitelist {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл правил типографирования содержит некорректный JSON.');
  }
  if (!isRecord(data)) throw new Error('Файл правил типографирования должен быть объектом JSON.');
  const version = data.schemaVersion;
  if (version !== schemaVersion) throw new Error(`Неподдерживаемая версия схемы правил типографирования: ${JSON.stringify(version)}. Нужна версия ${String(schemaVersion)}.`);
  const locale = data.locale;
  if (typeof locale !== 'string' || !Typograf.hasLocale(locale)) throw new Error(`Неизвестная локаль правил типографирования: ${JSON.stringify(locale)}.`);
  const rawRules = data.enabledRules;
  if (!Array.isArray(rawRules) || rawRules.some((rule) => typeof rule !== 'string')) throw new Error('Поле enabledRules должно быть массивом строк.');
  const enabledRules = rawRules as string[];
  const seen = new Set<string>();
  for (const rule of enabledRules) {
    if (rule === '' || rule.includes('*')) throw new Error(`Недопустимое имя правила типографирования: ${JSON.stringify(rule)}. Маски * не поддерживаются.`);
    if (seen.has(rule)) throw new Error(`Правило типографирования указано повторно: ${rule}`);
    seen.add(rule);
    const found = Typograf.getRule(rule);
    if (!found) throw new Error(`Неизвестное правило типографирования: ${rule}`);
    if (found.locale !== 'common' && found.locale !== locale) throw new Error(`Правило ${rule} относится к локали ${found.locale}, а не к locale ${locale} из файла правил.`);
  }
  return { schemaVersion: version, locale, enabledRules };
}

/** Path of the whitelist next to the manuscript, when `--typograf-rules` does not set another path. */
export function defaultWhitelistPath(inputPath: string): string {
  return join(dirname(inputPath), defaultWhitelistName);
}

/** Read and check a whitelist file. The file type and size are checked before the JSON parse. */
export function loadWhitelistFile(path: string): TypografWhitelist {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`Файл правил типографирования не найден: ${path}`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Файл правил типографирования должен быть обычным файлом: ${path}`);
  if (stat.size === 0) throw new Error(`Файл правил типографирования пустой: ${path}`);
  if (stat.size > whitelistLimit) throw new Error(`Файл правил типографирования больше ${String(Math.round(whitelistLimit / 1024))} КБ: ${path}`);
  if (extname(real).toLowerCase() !== '.json') throw new Error(`Файл правил типографирования должен иметь расширение .json: ${path}`);
  return parseWhitelist(readFileSync(real, 'utf8'));
}

/** Write a new whitelist file. Never replaces an existing file at that path. */
export function writeWhitelistFile(path: string, whitelist: TypografWhitelist): void {
  writeNewFile(path, renderWhitelist(whitelist));
}

export type TypografLineEnding = 'LF' | 'CR' | 'CRLF';

/** The line ending that the source text already uses, so the formatted text keeps the same style. */
export function detectLineEnding(text: string): TypografLineEnding {
  if (text.includes('\r\n')) return 'CRLF';
  if (text.includes('\r')) return 'CR';
  return 'LF';
}

/**
 * Run Typograf Core once over the whole manuscript text. Every rule starts disabled, and only the
 * rules from the whitelist turn on, so a Typograf Core update cannot enable a rule that the whitelist
 * does not name.
 */
export function typografExecute(text: string, whitelist: TypografWhitelist): string {
  const typograf = new Typograf({ locale: whitelist.locale, disableRule: '*', enableRule: [...whitelist.enabledRules], lineEnding: detectLineEnding(text) });
  return typograf.execute(text);
}

const formattedSuffixPattern = /\.formatted\.(md|markdown)$/i;

/** True for a name such as `book.formatted.md`, the file that Typograf Core writes, not a manuscript. */
export function isFormattedManuscriptName(name: string): boolean {
  return formattedSuffixPattern.test(name);
}

/** `manuscript.md` → `manuscript.formatted.md`, next to the source file. */
export function formattedManuscriptPath(inputPath: string): string {
  const extension = extname(inputPath) || '.md';
  const stem = inputPath.slice(0, inputPath.length - extension.length);
  return `${stem}.formatted${extension}`;
}

/**
 * Replace the formatted manuscript with the new text. The write is atomic: a temporary file next to
 * the target gets renamed over it. A symbolic link or a file with other hard links at the target
 * stops the write, so the command never changes a file through a link or a file that another path
 * also owns. Unlike a build result, this file is always replaced and does not depend on `--overwrite`.
 */
export function writeFormattedManuscript(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  try {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error(`Форматированный манускрипт — символическая ссылка: ${path}. Удалите его и запустите сборку снова.`);
      if (!stat.isFile()) throw new Error(`По пути форматированного манускрипта лежит не обычный файл: ${path}.`);
      if (stat.nlink !== 1) throw new Error(`У форматированного манускрипта есть другие жёсткие ссылки: ${path}. Удалите его и запустите сборку снова.`);
      chmodSync(temporary, stat.mode & 0o777);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
