import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';

import { logName } from '@moveToRepo/log';
import { type DirectoryId, directoryId, inDirectory } from '@moveToRepo/tools';

export const maxFiles = 100;
export const maxFileSize = 10 * 1024 * 1024;
export const maxTotalSize = 50 * 1024 * 1024;
const maxPathLength = 1024;
const maxSegmentLength = 255;

/**
 * One path segment: Latin and Russian Cyrillic letters, digits, and `_ + @ - .`, with single spaces between other characters.
 * The first character cannot be a dot, a hyphen, or a space. This rejects `.`, `..`, `.git`, `.env`, and option-like names.
 * The check uses the NFC form, so a decomposed letter from the file system, such as a Cyrillic short i, is the same name.
 */
const segmentPattern = /^[A-Za-zА-яЁё0-9_+@](?:[A-Za-zА-яЁё0-9_+@.-]| (?! ))*$/;
/**
 * Each word, a sequence of letters without other characters, must use one script.
 * This rejects a Cyrillic letter that looks like a Latin letter inside a Latin word, for example a Cyrillic `e` in `file.txt`.
 */
const wordPattern = /[A-Za-zА-яЁё]+/g;
const oneScriptWord = /^(?:[A-Za-z]+|[А-яЁё]+)$/;

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
  [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, 'ключ API'],
  [/\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/, 'ключ API'],
  [/\b[rs]k_live_[A-Za-z0-9]{20,}/, 'ключ Stripe'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'ключ Google API'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'токен JWT']
];

export type Entry = { source: string; target: string };
export type SourceFile = Entry & { content: Buffer; executable: boolean };

/**
 * Check a relative path and return its segments. A leading `./` is accepted for a source path.
 * The rules apply to the NFC form. The segments keep the given form, so the file opens with the name the user gave.
 */
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
    const normal = segment.normalize('NFC');
    if (normal.length > maxSegmentLength || !segmentPattern.test(normal)) {
      throw new Error(`${label}: недопустимые символы в пути: ${value}. Разрешены латинские и русские буквы, цифры, _ + @ - . и одиночные пробелы внутри имени.`);
    }
    if (!(normal.match(wordPattern) ?? []).every((word) => oneScriptWord.test(word))) {
      throw new Error(`${label}: латинские и русские буквы смешаны в одном слове: ${value}. Похожие буквы из разных алфавитов запрещены.`);
    }
    if (normal.endsWith('.') || normal.endsWith(' ')) throw new Error(`${label}: имя не может заканчиваться точкой или пробелом: ${value}`);
  }
  return segments;
}

/**
 * Return the reason when a file name looks like a secret file, otherwise undefined.
 * Check all extensions, not only the last one: `terraform.tfstate.backup` and `server.key.old` are secret files too.
 */
export function secretName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const extension = lower
    .split('.')
    .slice(1)
    .find((part) => secretExtensions.has(part));
  if (extension !== undefined) return `расширение .${extension}`;
  if (secretNames.has(lower) || secretNamePattern.test(lower)) return 'имя файла';
  return undefined;
}

/**
 * Return the kind of secret when the contents contain a known token format, otherwise undefined.
 * The text without NUL bytes is checked too. Then UTF-16 text with Latin letters also matches the patterns.
 */
export function secretContent(content: Buffer): string | undefined {
  const text = content.toString('latin1');
  const texts = text.includes('\0') ? [text, text.replaceAll('\0', '')] : [text];
  return secretContentPatterns.find(([pattern]) => texts.some((value) => pattern.test(value)))?.[1];
}

/**
 * Reject a root directory when its real path has a segment that starts with a dot, for example `~/.docker` or `~/.config/gh`.
 * The real path must lead to the expected directory. Each later step into the root checks the identity again.
 */
export function checkRoot(root: string, expected: DirectoryId = directoryId(root)): void {
  const real = realpathSync(root);
  if (real.split('/').some((segment) => segment.startsWith('.'))) {
    throw new Error(`Текущий каталог находится внутри каталога, имя которого начинается с точки: ${real}. Такие каталоги часто содержат секреты, запуск из них запрещён.`);
  }
  const actual = directoryId(real);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`Каталог ${root} изменился во время работы. Запуск остановлен.`);
}

/**
 * Map a source path and a destination directory to the path in the repository. `.` is the repository root.
 * The repository path uses the NFC form, so the same name in a different Unicode form cannot make a second file.
 */
export function targetPath(source: string, dest: string): string {
  const segments = pathSegments(source, 'Файл', true);
  const name = segments.at(-1) ?? '';
  const target = dest === '.' ? name : `${pathSegments(dest, '--dest').join('/')}/${name}`;
  return target.normalize('NFC');
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
    if (entry.source.split('/').at(-1)?.toLowerCase() === logName) throw new Error(`Журнал ${logName} нельзя копировать.`);
    pathSegments(entry.target, 'Путь в репозитории');
    const key = entry.target.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) throw new Error(`Два файла попадают в один путь репозитория: ${previous} и ${entry.target}.`);
    seen.set(key, entry.target);
  }
}

/**
 * Read one source file below the root directory. Do not follow symbolic links in any segment.
 * Reject hard links, special files, and large files.
 *
 * Node.js has no `openat`, so the current directory is the directory handle. The function goes into the root
 * and checks its identity (see `inDirectory`). Then it goes into each directory with a relative name and compares
 * the device and inode of `.` with the checked directory. A directory that is replaced by a link after the check
 * gives another inode, and the run stops. The file name is opened relative to the current
 * directory with `O_NOFOLLOW`, so a change of a parent name after the step cannot select another file.
 * All file checks use the opened descriptor.
 */
export function readSource(root: string, source: string, rootId: DirectoryId = directoryId(root)): { content: Buffer; executable: boolean } {
  const segments = pathSegments(source, 'Файл', true);
  const name = segments.at(-1) ?? '';
  return inDirectory(root, rootId, () => {
    for (const segment of segments.slice(0, -1)) {
      let stat;
      try {
        stat = lstatSync(segment);
      } catch {
        throw new Error(`Файл не найден: ${source}`);
      }
      if (stat.isSymbolicLink()) throw new Error(`Символические ссылки запрещены: ${source}`);
      if (!stat.isDirectory()) throw new Error(`Файл не найден: ${source}`);
      process.chdir(segment);
      const entered = statSync('.');
      if (entered.dev !== stat.dev || entered.ino !== stat.ino) throw new Error(`Каталог изменился во время проверки: ${source}`);
    }
    // Open first, then check the opened file. The checks and the read use the same descriptor, so no path check can go stale.
    let fd;
    try {
      fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`Символические ссылки запрещены: ${source}`, { cause: error });
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Файл не найден: ${source}`, { cause: error });
      throw new Error(`Нужен обычный файл: ${source}`, { cause: error });
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error(`Нужен обычный файл: ${source}`);
      if (opened.nlink !== 1) throw new Error(`Файлы с жёсткими ссылками запрещены: ${source}`);
      if (opened.size > maxFileSize) throw new Error(`Файл больше ${maxFileSize / 1024 / 1024} МиБ: ${source}`);
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
  });
}

/** Read all files. Check the total size and the contents for known secret formats. `rootId` is the identity of the root at the start. */
export function readSources(root: string, entries: Entry[], rootId: DirectoryId = directoryId(root)): SourceFile[] {
  checkEntries(entries);
  checkRoot(root, rootId);
  let total = 0;
  return entries.map((entry) => {
    const { content, executable } = readSource(root, entry.source, rootId);
    total += content.length;
    if (total > maxTotalSize) throw new Error(`Общий размер файлов больше ${maxTotalSize / 1024 / 1024} МиБ.`);
    const secret = secretContent(content);
    if (secret) throw new Error(`Файл похож на секрет (${secret}): ${entry.source}. Такие файлы запрещены.`);
    return { ...entry, content, executable };
  });
}
