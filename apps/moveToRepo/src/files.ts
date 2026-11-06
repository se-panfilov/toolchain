import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const maxFiles = 100;
export const maxFileSize = 10 * 1024 * 1024;
export const maxTotalSize = 50 * 1024 * 1024;
const maxPathLength = 1024;
const maxSegmentLength = 255;

/**
 * One path segment: ASCII letters, digits, and `_ + @ - .`, with single spaces between other characters.
 * The first character cannot be a dot, a hyphen, or a space. This rejects `.`, `..`, `.git`, `.env`, and option-like names.
 * ASCII only: similar-looking letters from other scripts and Unicode normalization cannot change the path.
 */
const segmentPattern = /^[A-Za-z0-9_+@](?:[A-Za-z0-9_+@.-]| (?! ))*$/;

// Typical files with keys, certificates with private keys, password stores, and credentials.
const secretExtensions = new Set(['pem', 'key', 'p12', 'pfx', 'p8', 'jks', 'keystore', 'ppk', 'asc', 'gpg', 'pgp', 'kdbx', 'ovpn', 'env', 'tfstate', 'tfvars', 'secret', 'secrets']);
const secretNames = new Set([
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
  'known_hosts',
  'authorized_keys',
  'htpasswd',
  '_netrc',
  'npmrc',
  'pypirc'
]);
const secretNamePattern = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/i;
// High-confidence token formats. A match stops the run. Other secret formats are not detected.
const secretContentPatterns: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, 'закрытый ключ'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'токен GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, 'токен GitHub'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'токен GitLab'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'ключ AWS'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'токен Slack'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'токен npm'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'ключ API'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'ключ Google API']
];

export type Entry = { source: string; target: string };
export type SourceFile = Entry & { content: Buffer; executable: boolean };

/** Check a relative path and return its segments. A leading `./` is accepted for a source path. */
export function pathSegments(value: string, label: string, leadingDot = false): string[] {
  const path = leadingDot && value.startsWith('./') ? value.slice(2) : value;
  if (path === '') throw new Error(`${label}: пустой путь.`);
  if (path.length > maxPathLength) throw new Error(`${label}: путь длиннее ${maxPathLength} символов.`);
  if (path.startsWith('/')) throw new Error(`${label}: нужен относительный путь, без / в начале: ${value}`);
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') throw new Error(`${label}: пустой сегмент пути (// или / в конце): ${value}`);
    if (segment === '..' || segment === '.') throw new Error(`${label}: выход из каталога запрещён: ${value}`);
    if (segment.startsWith('.')) throw new Error(`${label}: файлы и каталоги, имя которых начинается с точки, запрещены: ${value}`);
    if (segment.length > maxSegmentLength || !segmentPattern.test(segment)) {
      throw new Error(`${label}: недопустимые символы в пути: ${value}. Разрешены латинские буквы, цифры, _ + @ - . и одиночные пробелы внутри имени.`);
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) throw new Error(`${label}: имя не может заканчиваться точкой или пробелом: ${value}`);
  }
  return segments;
}

/** Return the reason when a file name looks like a secret file, otherwise undefined. */
export function secretName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot + 1) : '';
  if (secretExtensions.has(extension)) return `расширение .${extension}`;
  if (secretNames.has(lower) || secretNamePattern.test(lower)) return 'имя файла';
  return undefined;
}

/** Return the kind of secret when the contents contain a known token format, otherwise undefined. */
export function secretContent(content: Buffer): string | undefined {
  const text = content.toString('latin1');
  return secretContentPatterns.find(([pattern]) => pattern.test(text))?.[1];
}

/** Map a source path and a destination directory to the path in the repository. `.` is the repository root. */
export function targetPath(source: string, dest: string): string {
  const segments = pathSegments(source, 'Файл', true);
  const name = segments.at(-1) ?? '';
  return dest === '.' ? name : `${pathSegments(dest, '--dest').join('/')}/${name}`;
}

/** Check the list: limits, secret names, and duplicate destinations, also without letter case. */
export function checkEntries(entries: Entry[]): void {
  if (entries.length === 0) throw new Error('Не указаны файлы.');
  if (entries.length > maxFiles) throw new Error(`Слишком много файлов: ${entries.length}. Максимум ${maxFiles}.`);
  const seen = new Map<string, string>();
  for (const entry of entries) {
    for (const segment of [...pathSegments(entry.source, 'Файл', true), ...entry.target.split('/')]) {
      const reason = secretName(segment);
      if (reason) throw new Error(`Похоже на файл с секретами (${reason}): ${entry.source}. Такие файлы запрещены.`);
    }
    pathSegments(entry.target, 'Путь в репозитории');
    const key = entry.target.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) throw new Error(`Два файла попадают в один путь репозитория: ${previous} и ${entry.target}.`);
    seen.set(key, entry.target);
  }
}

/**
 * Read one source file below the root directory. Do not follow symbolic links in any segment.
 * Reject hard links, special files, and large files. The opened file must be the checked file:
 * a link that replaces a directory after the check opens another inode, and the inode check stops the run.
 */
export function readSource(root: string, source: string): { content: Buffer; executable: boolean } {
  const segments = pathSegments(source, 'Файл', true);
  let current = root;
  let stat;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`Файл не найден: ${source}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Символические ссылки запрещены: ${source}`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`Файл не найден: ${source}`);
  }
  if (!stat?.isFile()) throw new Error(`Нужен обычный файл: ${source}`);
  if (stat.nlink !== 1) throw new Error(`Файлы с жёсткими ссылками запрещены: ${source}`);
  if (stat.size > maxFileSize) throw new Error(`Файл больше ${maxFileSize / 1024 / 1024} МиБ: ${source}`);
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || opened.size !== stat.size) {
      throw new Error(`Файл изменился во время проверки: ${source}`);
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const read = readSync(fd, content, offset, content.length - offset, offset);
      if (read === 0) throw new Error(`Файл изменился во время чтения: ${source}`);
      offset += read;
    }
    return { content, executable: (opened.mode & 0o100) !== 0 };
  } finally {
    closeSync(fd);
  }
}

/** Read all files. Check the total size and the contents for known secret formats. */
export function readSources(root: string, entries: Entry[]): SourceFile[] {
  checkEntries(entries);
  let total = 0;
  return entries.map((entry) => {
    const { content, executable } = readSource(root, entry.source);
    total += content.length;
    if (total > maxTotalSize) throw new Error(`Общий размер файлов больше ${maxTotalSize / 1024 / 1024} МиБ.`);
    const secret = secretContent(content);
    if (secret) throw new Error(`Файл похож на секрет (${secret}): ${entry.source}. Такие файлы запрещены.`);
    return { ...entry, content, executable };
  });
}
