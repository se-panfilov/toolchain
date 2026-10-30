// Git hook checks from AGENTS.md: no commits or pushes to master or main, and no AI agent session links in commit messages.
// Usage: node scripts/git-rules.mjs branch | push | message <commit-message-file>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { pathToFileURL } from 'node:url';

import { readRegularFile } from './ci/files.mjs';
import { aiLinkProblems, protectedBranches } from './ci/rules.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
const gitNullConfig = process.platform === 'win32' ? 'nul' : devNull;
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitNullConfig, GIT_CONFIG_GLOBAL: gitNullConfig, GIT_OPTIONAL_LOCKS: '0' });
const messageLimit = 1024 * 1024;

function currentBranch() {
  const result = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.error) throw new Error('Не удалось запустить Git.');
  // Status 1 means a detached HEAD, for example during a rebase. Such a commit does not update a protected branch.
  if (result.status === 1) return '';
  if (result.status !== 0) throw new Error('Не удалось определить текущую ветку.');
  return result.stdout.trim();
}

// Git gives pre-push one line for each ref: <local ref> <local object> <remote ref> <remote object>.
export function pushProblems(input) {
  const problems = [];
  for (const line of input.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const remoteRef = line.trim().split(/\s+/)[2] ?? '';
    const branch = remoteRef.replace(/^refs\/heads\//, '');
    if (remoteRef.startsWith('refs/heads/') && protectedBranches.includes(branch)) problems.push(`Push в ${branch} запрещён. Отправьте ветку задачи и откройте pull request.`);
  }
  return problems;
}

// Remove the lines that Git removes with the default cleanup mode before the message check.
export function commitMessageProblems(text) {
  const message = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  return aiLinkProblems(message, 'Сообщение коммита');
}

function readMessage(path) {
  const text = readRegularFile(path, messageLimit);
  if (text === undefined) throw new Error('Файл сообщения коммита не найден.');
  return text;
}

function main() {
  const [mode, path, ...rest] = process.argv.slice(2);
  let problems;
  if (mode === 'branch' && path === undefined) {
    const branch = currentBranch();
    problems = protectedBranches.includes(branch) ? [`Коммит в ${branch} запрещён. Создайте ветку задачи <type>/<short_description>.`] : [];
  } else if (mode === 'push' && path === undefined) {
    problems = pushProblems(readFileSync(0, 'utf8'));
  } else if (mode === 'message' && path && rest.length === 0) {
    problems = commitMessageProblems(readMessage(path));
  } else {
    throw new Error('Используйте: git-rules.mjs branch | push | message <файл>');
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(String(error.message).replace(/[\p{Cc}\p{Cf}]/gu, '?'));
    process.exitCode = 2;
  }
}
