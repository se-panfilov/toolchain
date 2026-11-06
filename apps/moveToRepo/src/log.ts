import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, type Stats, writeSync } from 'node:fs';
import { posix } from 'node:path';

import { type DirectoryId, directoryId, inDirectory } from '@moveToRepo/tools';

/** The operation log in the current directory. The name starts with `__`. */
export const logName = '__movetorepo-log.md';

const header = '# Журнал moveToRepo\n\nКаждая запись — одна операция копирования. Время указано в локальном часовом поясе и в UTC.\n';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** The local date and time with the UTC offset, and the same moment in UTC: `2026-01-02 15:04:05 UTC+01:00 (UTC 2026-01-02T14:04:05Z)`. */
export function formatTime(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${local} ${zone} (UTC ${date.toISOString().replace(/\.\d{3}Z$/, 'Z')})`;
}

/** Inline code for Markdown. Control characters become `?`. The fence is longer than any run of backticks in the text. */
export function code(value: string): string {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, '?');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const space = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${space}${text}${space}${fence}`;
}

export type LogFile = { source: string; target: string; state: 'add' | 'replace' };
/**
 * Hide known token formats and credentials in URLs and headers. Error text from Git and gh goes to the log through this function.
 * Other secret formats are not detected.
 */
export function redact(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[скрыто]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[скрыто]@')
    .replace(/\b(authorization:\s*)(?:(bearer|token|basic)\s+)?\S+/gi, (_, name: string, scheme?: string) => `${name}${scheme ? `${scheme} ` : ''}[скрыто]`);
}

export type LogStart = { id: string; time: Date; directory: string; repository: string; base: string; branch: string; commit: string; files: LogFile[] };

/** The first part of a log entry. It is written before the push. moveToRepo runs on macOS and Linux, so local paths use `/`. */
export function startEntry(entry: LogStart): string {
  const files = entry.files.map((file) => `  - ${code(posix.join(entry.directory, file.source))} → ${code(file.target)} (${file.state === 'add' ? 'новый' : 'замена'})`);
  return [
    '',
    `## ${formatTime(entry.time)} · операция ${code(entry.id)}`,
    '',
    `- ID операции: ${code(entry.id)}`,
    `- Дата и время: ${formatTime(entry.time)}`,
    `- Целевой репозиторий: ${code(entry.repository)} (https://github.com/${entry.repository})`,
    `- Целевая ветка: ${code(entry.base)}`,
    `- Новая ветка: ${code(entry.branch)}`,
    `- Коммит: ${code(entry.commit)}`,
    `- Локальный каталог: ${code(entry.directory)}`,
    `- Скопированные файлы (${entry.files.length}):`,
    ...files,
    '- Статус: отправка начата',
    ''
  ].join('\n');
}

/**
 * The result of an operation: the pull request or the error. Parallel runs can write between the start and the result,
 * so the result line names the operation ID. The detail is in inline code with known tokens hidden.
 */
export function resultLine(id: string, time: Date, result: string, detail?: string): string {
  const text = detail === undefined ? '' : ` ${code(redact(detail).replace(/\s+/g, ' ').trim())}`;
  return `- Результат операции ${code(id)} (${formatTime(time)}): ${result.replace(/[\p{Cc}\p{Cf}]/gu, ' ')}${text}\n`;
}

/**
 * Check the log path without a write. A missing file is accepted. An existing path must be a regular file
 * of the current user with one link. A symbolic link stops the run. Use it before network access.
 */
export function checkLog(directory: string, expected: DirectoryId = directoryId(directory)): void {
  inDirectory(directory, expected, () => {
    let stat;
    try {
      stat = lstatSync(logName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Журнал ${logName} недоступен: ${(error as Error).message}`, { cause: error });
    }
    checkStat(stat);
  });
}

function checkStat(stat: Stats): void {
  if (stat.isSymbolicLink()) throw new Error(`Журнал ${logName} — символическая ссылка. Удалите или переименуйте его.`);
  if (!stat.isFile()) throw new Error(`Журнал ${logName} — не обычный файл.`);
  if (stat.nlink !== 1) throw new Error(`У журнала ${logName} есть жёсткие ссылки. Удалите их или переименуйте журнал.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`Журнал ${logName} принадлежит другому пользователю.`);
}

/**
 * The append-only operation log. The file opens relative to the checked directory with `O_APPEND` and `O_NOFOLLOW`.
 * A new file gets mode `0600`. An existing file with access for the group or others is changed to `0600`.
 * The checks use the opened descriptor. Each record is one write followed by `fsync`, so records of parallel runs do not mix.
 */
export class OperationLog {
  private constructor(private fd: number | undefined) {}

  static open(directory: string, expected: DirectoryId = directoryId(directory)): OperationLog {
    let fd;
    try {
      fd = inDirectory(directory, expected, () => openSync(logName, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600));
    } catch (error) {
      if (!(error as NodeJS.ErrnoException).code) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`Журнал ${logName} — символическая ссылка. Удалите или переименуйте его.`, { cause: error });
      throw new Error(`Не удалось открыть журнал ${logName}: ${(error as Error).message}`, { cause: error });
    }
    try {
      const stat = fstatSync(fd);
      checkStat(stat);
      if ((stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      if (stat.size === 0) {
        writeSync(fd, header);
        fsyncSync(fd);
      }
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return new OperationLog(fd);
  }

  write(text: string): void {
    if (this.fd === undefined) throw new Error('Журнал закрыт.');
    const data = Buffer.from(text, 'utf8');
    const written = writeSync(this.fd, data);
    if (written !== data.length) throw new Error(`Запись в журнал ${logName} не завершена.`);
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}
