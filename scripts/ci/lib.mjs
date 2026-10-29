import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export const registry = 'https://registry.npmjs.org/';
export const releaseRef = 'refs/heads/master';
// Each of these workflows has an `app` choice input that must list `all` and every application directory.
export const workflows = ['.github/workflows/test.yml', '.github/workflows/build.yml', '.github/workflows/release.yml'];

const directoryName = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const command = /^[a-z][a-z0-9-]{0,63}$/;
const limits = { archive: 20 * 1024 * 1024, unpacked: 100 * 1024 * 1024, entries: 2000 };
const sensitiveName = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx))$/i;
const secretText = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, /\bnpm_[A-Za-z0-9]{36}\b/, /\bAKIA[0-9A-Z]{16}\b/, /_authToken\s*=/];

// Remove control and format characters before untrusted text reaches the log.
export const safe = (value) => String(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? character : '?'));

export function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Ожидался обычный файл: ${safe(path)}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Read and validate every application in apps/. An unexpected entry stops the workflow instead of being skipped.
export function listApps(base = root) {
  const appsDir = join(base, 'apps');
  const apps = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`В apps/ допустимы только каталоги приложений: ${safe(entry.name)}`);
    if (!directoryName.test(entry.name)) throw new Error(`Недопустимое имя каталога приложения: ${safe(entry.name)}`);
    const manifest = readJson(join(appsDir, entry.name, 'package.json'));
    const name = `tx-${entry.name.toLowerCase()}`;
    if (manifest.name !== name) throw new Error(`Пакет apps/${entry.name} должен называться ${name}.`);
    if (manifest.private === true) throw new Error(`Пакет ${name} помечен как private. Уберите его из apps/ или из публикации.`);
    if (typeof manifest.version !== 'string' || !version.test(manifest.version)) throw new Error(`Пакет ${name} должен иметь версию вида X.Y.Z.`);
    const bin = manifest.bin;
    if (!bin || typeof bin !== 'object' || Array.isArray(bin) || Object.keys(bin).length === 0) throw new Error(`Пакет ${name} должен объявить bin как объект.`);
    for (const [key, target] of Object.entries(bin)) {
      if (!command.test(key) || typeof target !== 'string' || !isPackagePath(target)) throw new Error(`Пакет ${name} содержит недопустимую запись bin.`);
    }
    apps.push({ dir: entry.name, name, version: manifest.version, bin });
  }
  apps.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const names = new Set(apps.map((app) => app.name));
  if (names.size !== apps.length) throw new Error('Имена каталогов приложений совпадают без учёта регистра.');
  if (apps.length === 0) throw new Error('В apps/ нет приложений.');
  return apps;
}

function isPackagePath(path) {
  const normalized = posix.normalize(path.replace(/^\.\//, ''));
  return normalized === path.replace(/^\.\//, '') && !normalized.startsWith('../') && !posix.isAbsolute(normalized) && !normalized.includes('\\') && normalized !== '..';
}

// Resolve the workflow input. Only `all` or an exact application directory name is accepted.
export function selectApps(value, apps) {
  if (value === 'all') return apps;
  if (typeof value !== 'string' || !directoryName.test(value)) throw new Error('Недопустимое значение app. Укажите all или имя каталога из apps/.');
  const app = apps.find((item) => item.dir === value);
  if (!app) throw new Error(`Приложение не найдено: ${value}. Доступно: ${apps.map((item) => item.dir).join(', ')}.`);
  return [app];
}

// Read the options of the `app` input under `on.workflow_dispatch.inputs`. The parser expects block-style YAML lists.
export function workflowChoices(text) {
  const lines = text.split(/\r?\n/);
  const indent = (line) => line.length - line.trimStart().length;
  const find = (start, end, pattern) => {
    for (let index = start; index < end; index += 1) if (pattern.test(lines[index])) return index;
    return -1;
  };
  const blockEnd = (start) => {
    const level = indent(lines[start]);
    let index = start + 1;
    while (index < lines.length && (lines[index].trim() === '' || lines[index].trimStart().startsWith('#') || indent(lines[index]) > level)) index += 1;
    return index;
  };
  const dispatch = find(0, lines.length, /^\s*workflow_dispatch:\s*$/);
  if (dispatch < 0) throw new Error('Не найден workflow_dispatch.');
  const inputs = find(dispatch + 1, blockEnd(dispatch), /^\s*inputs:\s*$/);
  if (inputs < 0) throw new Error('Не найден workflow_dispatch.inputs.');
  const app = find(inputs + 1, blockEnd(inputs), /^\s*app:\s*$/);
  if (app < 0) throw new Error('Не найден вход app.');
  const appEnd = blockEnd(app);
  if (find(app + 1, appEnd, /^\s*type:\s*choice\s*$/) < 0) throw new Error('Вход app должен иметь type: choice.');
  const options = find(app + 1, appEnd, /^\s*options:\s*$/);
  if (options < 0) throw new Error('Не найден список options входа app.');
  const choices = [];
  for (let index = options + 1; index < blockEnd(options); index += 1) {
    const match = /^\s*-\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/.exec(lines[index]);
    if (match) choices.push(match[2]);
    else if (lines[index].trim() !== '' && !lines[index].trimStart().startsWith('#')) throw new Error('Список options входа app должен содержать только простые значения.');
  }
  return choices;
}

// Compare every workflow choice list with apps/. Return a list of problems.
export function workflowProblems(apps, base = root) {
  const expected = ['all', ...apps.map((app) => app.dir)];
  const problems = [];
  for (const file of workflows) {
    let choices;
    try {
      choices = workflowChoices(readFileSync(join(base, file), 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
      continue;
    }
    if (choices.join('\n') === expected.join('\n')) continue;
    const missing = expected.filter((item) => !choices.includes(item));
    const extra = choices.filter((item) => !expected.includes(item));
    const details = [missing.length ? `нет ${missing.join(', ')}` : '', extra.length ? `лишние ${extra.join(', ')}` : ''].filter(Boolean).join('; ');
    problems.push(`${file}: варианты app должны быть [${expected.join(', ')}]${details ? ` (${details})` : ' в этом порядке'}.`);
  }
  return problems;
}

export function assertWorkflows(apps, base = root) {
  const problems = workflowProblems(apps, base);
  if (problems.length) throw new Error(`Списки приложений в GitHub Actions не совпадают с apps/:\n${problems.join('\n')}`);
}

export function isDryRun(value) {
  if (value === 'true') return true;
  if (value === 'false' || value === '' || value === undefined) return false;
  throw new Error('DRY_RUN должен быть true или false.');
}

// Real publication is allowed only from the default branch. A dry run can use any ref.
export function assertReleaseRef(dryRun, ref) {
  if (!dryRun && ref !== releaseRef) throw new Error(`Публикация разрешена только из ${releaseRef}. Текущая ссылка: ${safe(ref)}. Используйте dry_run.`);
}

export function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function parsePax(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error('Повреждён заголовок PAX в архиве.');
    const length = Number(body.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > body.length) throw new Error('Повреждён заголовок PAX в архиве.');
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator > 0) fields[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return fields;
}

// Parse a gzip tar archive in memory. Only regular files, directories, and PAX extended headers are accepted.
export function readTar(compressed) {
  if (compressed.length > limits.archive) throw new Error('Архив слишком большой.');
  const data = gunzipSync(compressed, { maxOutputLength: limits.unpacked });
  const entries = [];
  let offset = 0;
  let pax = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0[\s\S]*$/, '');
    const checksum = parseInt(field(148, 8).trim(), 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (checksum !== sum) throw new Error('Неверная контрольная сумма заголовка в архиве.');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Неверный размер записи в архиве.');
    const body = data.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error('Архив обрезан.');
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type === 'x') {
      pax = parsePax(body);
      continue;
    }
    if (type !== '0' && type !== '5') throw new Error(`Архив содержит запись недопустимого типа "${safe(type)}".`);
    const prefix = field(345, 155);
    const name = pax?.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    pax = null;
    entries.push({ name, type, size, mode: parseInt(field(100, 8).trim() || '0', 8), body });
    if (entries.length > limits.entries) throw new Error('Архив содержит слишком много записей.');
  }
  return entries;
}

// Check archive paths, links, metadata, entry points, and obvious secrets before upload or publication.
export function inspectArchive(compressed, app) {
  const entries = readTar(compressed);
  const files = new Map();
  for (const entry of entries) {
    const { name } = entry;
    const trimmed = name.replace(/\/$/, '');
    if (!name.startsWith('package/') || name.includes('\\') || posix.normalize(trimmed) !== trimmed || name.split('/').includes('..')) throw new Error(`Недопустимый путь в архиве: ${safe(name)}`);
    if (entry.type !== '0') continue;
    if (files.has(name)) throw new Error(`Повторяющийся путь в архиве: ${safe(name)}`);
    if (sensitiveName.test(name)) throw new Error(`Архив содержит файл, который может хранить секреты: ${safe(name)}`);
    const text = entry.body.toString('utf8');
    for (const pattern of secretText) if (pattern.test(text)) throw new Error(`Архив содержит текст, похожий на секрет: ${safe(name)}`);
    files.set(name, entry);
  }
  const manifestEntry = files.get('package/package.json');
  if (!manifestEntry) throw new Error('В архиве нет package/package.json.');
  const manifest = JSON.parse(manifestEntry.body.toString('utf8'));
  if (manifest.name !== app.name || manifest.version !== app.version) throw new Error('Имя или версия в архиве не совпадают с package.json приложения.');
  if (manifest.private === true) throw new Error('Архив содержит private-пакет.');
  const scripts = manifest.scripts ?? {};
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    if (hook in scripts) throw new Error(`Архив содержит скрипт установки ${hook}.`);
  }
  if (JSON.stringify(manifest.bin) !== JSON.stringify(app.bin)) throw new Error('bin в архиве не совпадает с package.json приложения.');
  for (const target of Object.values(app.bin)) {
    const entry = files.get(`package/${target.replace(/^\.\//, '')}`);
    if (!entry) throw new Error(`В архиве нет точки входа ${safe(target)}.`);
    if (!entry.body.toString('utf8').startsWith('#!/usr/bin/env node')) throw new Error(`Точка входа ${safe(target)} должна начинаться с #!/usr/bin/env node.`);
  }
  return { files: [...files.keys()].sort(), integrity: integrity(compressed) };
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, windowsHide: true, ...options });
  if (result.error) throw new Error(`Не удалось запустить ${program}: ${result.error.message}`, { cause: result.error });
  return result;
}

export function check(program, args, options = {}) {
  const result = run(program, args, options);
  if (result.status !== 0) throw new Error(`${program} ${args[0]} завершился с кодом ${result.status}.\n${safe(result.stderr ?? '')}`);
  return result.stdout ?? '';
}

// Interpret `npm view <name>@<version> dist.integrity --json`. An unknown version prints nothing, an unknown package returns E404.
export function parseRegistryView(status, stdout) {
  const text = (stdout ?? '').trim();
  if (status === 0) {
    if (text === '') return { published: false };
    const value = JSON.parse(text);
    if (typeof value !== 'string' || !value.startsWith('sha512-')) throw new Error('Реестр npm вернул неожиданный ответ.');
    return { published: true, integrity: value };
  }
  let code;
  try {
    code = JSON.parse(text)?.error?.code;
  } catch {
    code = undefined;
  }
  if (code === 'E404') return { published: false };
  throw new Error('Не удалось проверить версию в реестре npm. Публикация остановлена.');
}

export function registryState(app) {
  const result = run('npm', ['view', `${app.name}@${app.version}`, 'dist.integrity', '--json', `--registry=${registry}`]);
  return parseRegistryView(result.status, result.stdout);
}

export function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

export function output(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[\r\n]/.test(text) || !/^[a-z_]+$/.test(key)) throw new Error('Недопустимое значение для GITHUB_OUTPUT.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${text}\n`);
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function main(action) {
  try {
    await action();
  } catch (error) {
    console.error(`::error::${safe(error.message).replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
    process.exitCode = 1;
  }
}
