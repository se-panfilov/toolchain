import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { devNull } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getFileInfo } from 'prettier';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
// Git for Windows rejects os.devNull (\\.\nul) as a config path. The reserved name nul always selects the null device.
const gitNullConfig = process.platform === 'win32' ? 'nul' : devNull;
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitNullConfig, GIT_CONFIG_GLOBAL: gitNullConfig, GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1', FORCE_COLOR: '0' });
const safe = (value) => String(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? character : '?'));

function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true });
  if (result.error) throw new Error(`Не удалось запустить процесс: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`Процесс завершился с ошибкой (${result.status}):\n${result.stderr}`);
  return result.stdout;
}

function git(args) {
  const raw = run('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args]);
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw new Error('Пути Git должны иметь корректную кодировку UTF-8.');
  return text;
}

function changed(args) {
  const output = git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--name-only', '-z', '--diff-filter=ACMRTUXB', ...args, '--']);
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Git вернул неполный список файлов.');
  return output.slice(0, -1).split('\0');
}

function fileState(path, name) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) throw new Error(`Нужен обычный файл без ссылок: ${JSON.stringify(name)}.`);
  return JSON.stringify([stat.dev, stat.ino, stat.nlink, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

async function main() {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some((arg) => !['--staged', '--check'].includes(arg))) throw new Error('Допустимы параметры --staged и --check без повторов.');
  if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== root) throw new Error('Каталог скрипта должен быть корнем репозитория.');
  const configKeys = git(['config', '--null', '--name-only', '--list']).split('\0');
  if (configKeys.some((key) => /^filter\.[\s\S]*\.(?:clean|smudge|process)$/i.test(key)))
    throw new Error('Git-фильтры не поддерживаются. Используйте отдельную копию без filter.*.clean/process/smudge.');
  const staged = args.includes('--staged');
  const check = args.includes('--check');
  const names = changed(staged ? ['--cached'] : ['HEAD']);
  const unstaged = staged ? new Set(changed([])) : new Set();
  const files = [];
  for (const name of names) {
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (isAbsolute(name) || !rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Git вернул путь вне репозитория.');
    const info = await getFileInfo(path, { ignorePath: resolve(root, '.prettierignore'), resolveConfig: false });
    if (info.ignored || !info.inferredParser) continue;
    const state = fileState(path, name);
    if (unstaged.has(name)) throw new Error(`Файл содержит staged- и unstaged-изменения: ${JSON.stringify(name)}. Сначала разделите изменения.`);
    files.push({ path, name, state });
  }
  if (!files.length) {
    console.log('Изменённых файлов для форматирования нет.');
    return;
  }
  const require = createRequire(import.meta.url);
  const prettier = require.resolve('prettier/bin/prettier.cjs');
  // Absolute, existing paths remain literal CLI arguments. Never pass them through a shell.
  // Exclusive access is required between the path checks and Prettier writes.
  for (let start = 0; start < files.length; start += 100) {
    const batch = files.slice(start, start + 100);
    for (const file of batch) {
      if (fileState(file.path, file.name) !== file.state) throw new Error(`Файл изменился во время подготовки: ${JSON.stringify(file.name)}.`);
    }
    run(process.execPath, [prettier, check ? '--check' : '--write', '--ignore-path', resolve(root, '.prettierignore'), '--', ...batch.map((file) => file.path)]);
  }
  console.log(`${check ? 'Проверено' : 'Отформатировано'} файлов: ${files.length}.`);
}

try {
  await main();
} catch (error) {
  console.error(safe(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
