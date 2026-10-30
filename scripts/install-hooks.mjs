import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
// Hooks configured in lefthook.yml. Keep this list synchronized with the hook sections there.
const hooks = ['pre-commit', 'commit-msg', 'pre-push'];
const isProjectWrapper = (text) => text.includes('call_lefthook') && text.includes('node node_modules/lefthook/bin/index.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));

function git(args) {
  const result = spawnSync('git', ['--no-pager', ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Не удалось прочитать настройки Git.');
  return result.stdout.trim();
}

try {
  if (process.argv.length !== 2) throw new Error('Параметры не поддерживаются.');
  if (realpathSync.native(git(['rev-parse', '--show-toplevel'])) !== root) throw new Error('Скрипт должен находиться в корне репозитория.');
  if (git(['config', '--null', '--name-only', '--get-regexp', '^core\\.hookspath$'])) throw new Error('core.hooksPath уже настроен. Установка отменена без изменения настройки.');
  // --git-path can resolve a linked hooks directory before lstat can reject it.
  const directory = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'hooks');
  if (realpathSync.native(dirname(directory)) !== dirname(directory)) throw new Error('Родительский каталог hooks не должен содержать ссылки.');
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Каталог hooks должен быть обычным каталогом без ссылок.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const hook of hooks) {
    const path = join(directory, hook);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    // A wrapper from an earlier installation of this project can be replaced. Any other hook stays unchanged.
    if (!stat.isFile() || stat.isSymbolicLink() || !isProjectWrapper(readFileSync(path, 'utf8'))) {
      throw new Error(`${hook} уже существует. Сохраните и проверьте его перед ручной установкой Lefthook.`);
    }
  }
  const result = spawnSync(process.execPath, [join(root, 'node_modules/lefthook/bin/index.js'), 'install', ...hooks], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error('Lefthook не установил хук. Проверьте зависимости и права доступа.');
  console.log(`Хуки ${hooks.join(', ')} установлены. Индекс и настройки Git не изменены.`);
} catch (error) {
  console.error(String(error.message).replace(/[\p{Cc}\p{Cf}]/gu, '?'));
  process.exitCode = 1;
}
