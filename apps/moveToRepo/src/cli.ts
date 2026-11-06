#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Entry, readSources, targetPath } from '@moveToRepo/files';
import { type Change, Clone, pullRequestBody, pullRequestTitle } from '@moveToRepo/git';
import { checkBranch, checkOwner, cloneUrl, compareUrl, GitHub, parseRepository, type Repository } from '@moveToRepo/github';
import { checkLog, logName, OperationLog, resultLine, startEntry } from '@moveToRepo/log';
import { directoryId, findExecutable, Interrupted, safe } from '@moveToRepo/tools';

function help(): string {
  return `moveToRepo — копирование файлов в репозиторий GitHub через pull request.
macOS и Linux, Node.js 24.12+, Git, GitHub CLI (gh) с выполненным gh auth login.
Запуск: tx-movetorepo --repo URL [--base ВЕТКА] --dest КАТАЛОГ ФАЙЛ... [--dest КАТАЛОГ ФАЙЛ...]

  --repo URL        https://github.com/OWNER/REPO или git@github.com:OWNER/REPO.git
  --base ВЕТКА      Целевая ветка pull request. По умолчанию — ветка по умолчанию репозитория.
  --dest КАТАЛОГ    Каталог в репозитории для следующих файлов. . — корень репозитория.
  ФАЙЛ              Файл в текущем каталоге или его подкаталогах.
  --dry-run         Показать план без коммита, push и pull request.
  --version         Версия.
  --help            Справка.

Пример:
  tx-movetorepo --repo https://github.com/me/notes --base main \\
    --dest to-A from-A/some1.txt from-A/some2.txt --dest to-B from-B/some4.txt

Файлы копируются в новую ветку, затем открывается pull request в целевую ветку.
Только репозитории текущего пользователя GitHub (gh auth). Репозитории организаций и других людей запрещены.
Целевая ветка не изменяется. Force push не выполняется. Существующие файлы заменяются в pull request.
Каждая отправка записывается в журнал ${logName} в текущем каталоге: дата и время, файлы, репозиторий.
Запрещены: имена с точкой в начале, запуск из такого каталога, выход из каталога, символические и жёсткие ссылки, файлы секретов.
Сообщения выводятся в stderr, адрес pull request — в stdout.
Подробности: README.md пакета.`;
}

function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'неизвестно';
}

export type Arguments = { repo: Repository; base: string | undefined; entries: Entry[]; dryRun: boolean };

/**
 * Read the arguments. `--dest DIR` starts a group, and the next file names go to that directory.
 * Accept `--name value` and `--name=value`. Reject unknown and repeated options, empty values, and values that start with `-`.
 */
export function parseArguments(args: string[]): Arguments {
  let repo: Repository | undefined;
  let base: string | undefined;
  let dest: string | undefined;
  let dryRun = false;
  let group = 0;
  const entries: Entry[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) {
      if (dest === undefined) throw new Error(`Файл указан до --dest: ${arg}`);
      entries.push({ source: arg, target: targetPath(arg, dest) });
      group++;
      continue;
    }
    const at = arg.indexOf('=');
    const name = at === -1 ? arg : arg.slice(0, at);
    if (name === '--dry-run' && at === -1) {
      if (dryRun) throw new Error('Параметр указан повторно: --dry-run');
      dryRun = true;
      continue;
    }
    if (name !== '--repo' && name !== '--base' && name !== '--dest') throw new Error(`Неизвестный параметр: ${name}. Используйте --help.`);
    const value = at === -1 ? args[++i] : arg.slice(at + 1);
    if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`Нет значения для ${name}.`);
    if (name === '--repo') {
      if (repo) throw new Error('Параметр указан повторно: --repo');
      repo = parseRepository(value);
    } else if (name === '--base') {
      if (base !== undefined) throw new Error('Параметр указан повторно: --base');
      base = checkBranch(value, '--base');
    } else {
      if (dest !== undefined && group === 0) throw new Error(`Нет файлов для --dest ${dest}.`);
      // Check the directory now, before the files of the group.
      targetPath('file', value);
      dest = value;
      group = 0;
    }
  }
  if (!repo) throw new Error('Укажите --repo.');
  if (dest === undefined) throw new Error('Укажите --dest и файлы.');
  if (group === 0) throw new Error(`Нет файлов для --dest ${dest}.`);
  return { repo, base, entries, dryRun };
}

export function checkRuntime(platform = process.platform, node = process.versions.node): void {
  const [major = 0, minor = 0] = node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) throw new Error('Требуется Node.js 24.12 или новее.');
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('moveToRepo поддерживает только macOS и Linux.');
}

const marks: Record<Change['state'], string> = { add: '+ новый   ', replace: '~ замена  ', same: '= без изменений' };

function say(value: unknown): void {
  process.stderr.write(`${safe(value)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0] ?? '')) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
    process.stdout.write(`${version()}\n`);
    return;
  }
  const options = parseArguments(args);
  checkRuntime();
  // The identity of the start directory. `.` is the directory where the process runs, not a path that can change.
  // Each later step into the directory by its path checks this identity: reading files and opening the log.
  const rootId = directoryId('.');
  const directory = process.cwd();
  // Read and check all local files before any network access.
  const files = readSources(directory, options.entries, rootId);
  if (!options.dryRun) checkLog(directory, rootId);
  const git = findExecutable('git');
  const gh = findExecutable('gh');
  const work = mkdtempSync(join(tmpdir(), 'tx-movetorepo-'));
  // Ctrl+C stops the current Git or gh process, and runTool stops the run. A signal between processes
  // is seen at the next checkpoint, before the next network step. Then the temporary directory is removed.
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
  };
  const checkpoint = async (): Promise<void> => {
    await new Promise((done) => setImmediate(done));
    if (interrupted) throw new Interrupted();
  };
  // SIGHUP comes when the terminal closes. Without a handler, Node.js stops at once and leaves the temporary clone.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, interrupt);
  try {
    await checkpoint();
    const github = new GitHub(gh, work);
    const info = github.repository(options.repo);
    const user = github.currentUser();
    checkOwner(info, user);
    const base = options.base ?? info.defaultBranch;
    if (!base) throw new Error('У репозитория нет ветки по умолчанию. Укажите --base.');
    say(`Репозиторий: ${info.fullName} (владелец — текущий пользователь ${user})`);
    say(`Целевая ветка: ${base}`);

    const url = cloneUrl(options.repo);
    await checkpoint();
    const clone = new Clone(git, gh, work);
    clone.clone(url, base);
    const changes = clone.plan(files);
    for (const change of changes) say(`  ${marks[change.state]} ${change.target}  ← ${change.source}`);
    const changed = changes.filter((change) => change.state !== 'same');
    if (changed.length === 0) {
      say(`Все файлы в ${base} уже такие же. Pull request не нужен.`);
      return;
    }
    if (options.dryRun) {
      say('Dry-run: коммит, push и pull request не выполнялись.');
      return;
    }

    await checkpoint();
    const commit = clone.commit(changed);
    let branch = '';
    for (let attempt = 0; attempt < 3 && !branch; attempt++) {
      const candidate = `movetorepo/${randomBytes(4).toString('hex')}`;
      if (!clone.branchExists(url, candidate)) branch = candidate;
    }
    if (!branch) throw new Error('Не удалось выбрать свободное имя ветки.');
    say(`Новая ветка: ${branch}`);
    await checkpoint();
    // Write the log entry before the push. A log that cannot be written stops the run before any transfer.
    const log = OperationLog.open(directory, rootId);
    // Parallel runs in the same directory can write between the start and the result of this operation.
    const id = randomUUID();
    try {
      log.write(
        startEntry({
          id,
          time: new Date(),
          directory,
          repository: info.fullName,
          base,
          branch,
          commit,
          files: changed.map(({ source, target, state }) => ({ source, target, state: state === 'add' ? 'add' : 'replace' }))
        })
      );
      say(`Журнал: ${logName}`);
      let pushed = false;
      try {
        clone.push(url, commit, branch);
        pushed = true;
        let pr: string;
        try {
          pr = github.createPullRequest(info, base, branch, pullRequestTitle(changed), pullRequestBody(changed));
        } catch (error) {
          say(`Ветка ${branch} отправлена, но pull request не создан.`);
          say(`Откройте его вручную: ${compareUrl(info, base, branch)}`);
          throw error;
        }
        log.write(resultLine(id, new Date(), `pull request ${pr}`));
        say('✓ Pull request создан');
        process.stdout.write(`${safe(pr)}\n`);
      } catch (error) {
        const prefix = pushed ? 'ветка отправлена, pull request не создан, ' : '';
        try {
          log.write(
            error instanceof Interrupted ? resultLine(id, new Date(), `${prefix}прервано`) : resultLine(id, new Date(), `${prefix}ошибка:`, error instanceof Error ? error.message : String(error))
          );
        } catch {
          say(`Не удалось записать результат в журнал ${logName}.`);
        }
        throw error;
      }
    } finally {
      log.close();
    }
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
    rmSync(work, { recursive: true, force: true });
  }
}

// An npm bin can be a symbolic link. Compare the real paths.
let entry = '';
try {
  if (process.argv[1]) entry = pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  /* Import from stdin or eval. */
}
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    if (error instanceof Interrupted) {
      say('Прервано.');
      process.exitCode = 130;
    } else {
      say(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });
}
