// Check pull request rules from AGENTS.md: branch name, description, commit messages, version changes, and new dependencies.
// Dependabot pull requests skip only the branch name and description checks. See docs/GITHUB_ACTIONS.md.
// Usage: PR_AUTHOR=<login> HEAD_REF=<branch> BASE_SHA=<sha> HEAD_SHA=<sha> PR_TITLE=<text> PR_BODY=<text> node scripts/ci/pr-rules.mjs
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';

import { listApps, main, root, safe, summary } from './lib.mjs';
import { aiLinkProblems, branchProblems, isDependabotPullRequest, lockfileChanges, pullRequestBodyProblems, versionProblems } from './rules.mjs';

const objectName = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });

function git(args, allowMissing = false) {
  const result = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  if (result.error) throw new Error(`Не удалось запустить Git: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowMissing) return undefined;
    throw new Error(`git ${args[0]} завершился с кодом ${result.status}. Для проверки нужна полная история (fetch-depth: 0).`);
  }
  return result.stdout;
}

function readJsonAt(revision, path) {
  const text = git(['show', `${revision}:${path}`], true);
  return text === undefined ? undefined : JSON.parse(text);
}

await main(() => {
  const { PR_AUTHOR: author = '', HEAD_REF: headRef = '', BASE_SHA: baseSha = '', HEAD_SHA: headSha = '', PR_TITLE: title = '', PR_BODY: body = '' } = process.env;
  if (!objectName.test(baseSha) || !objectName.test(headSha)) throw new Error('BASE_SHA и HEAD_SHA должны быть полными идентификаторами коммитов.');
  const mergeBase = git(['merge-base', baseSha, headSha]).trim();
  const dependabot = isDependabotPullRequest(author, headRef);
  if (dependabot) console.log('Pull request от Dependabot: имя ветки и шаблон описания не проверяются.');
  const templateProblems = dependabot ? [] : [...branchProblems(headRef), ...pullRequestBodyProblems(body)];
  const problems = [...templateProblems, ...aiLinkProblems(`${title}\n${body}`, 'Заголовок или описание PR')];

  // Commit messages are separated by NUL, because a message can contain any other character.
  const commits = git(['log', '--format=%H%x00%B%x00', `${mergeBase}..${headSha}`]).split('\0');
  for (let index = 0; index + 1 < commits.length; index += 2) {
    const sha = (commits[index] ?? '').trim();
    problems.push(...aiLinkProblems(commits[index + 1] ?? '', `Коммит ${sha.slice(0, 12)}`));
  }

  const changedFiles = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', mergeBase, headSha]).split('\0').filter(Boolean);
  const apps = listApps().map((app) => ({ ...app, baseVersion: readJsonAt(mergeBase, `apps/${app.dir}/package.json`)?.version }));
  problems.push(...versionProblems(apps, changedFiles));

  if (changedFiles.includes('package-lock.json')) {
    const { changes, problems: lockProblems } = lockfileChanges(readJsonAt(mergeBase, 'package-lock.json'), readJsonAt(headSha, 'package-lock.json'));
    problems.push(...lockProblems);
    if (changes.length) {
      const list = changes.map((change) => `- \`${safe(change)}\``).join('\n');
      console.log(`Изменённые пакеты в package-lock.json:\n${list}`);
      summary(`### Изменённые пакеты\n\nПроверьте необходимость и безопасность каждой зависимости.\n\n${list}\n`);
      // Known vulnerabilities of high or critical severity stop the pull request. The check reads only the lockfile.
      const audit = spawnSync('npm', ['audit', '--package-lock-only', '--audit-level=high', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 120000, shell: false });
      if (audit.stdout) console.log(safe(audit.stdout).slice(0, 20000));
      if (audit.error || audit.status !== 0) problems.push('npm audit нашёл уязвимости уровня high или critical, или не смог выполнить проверку. Запустите npm audit локально.');
    }
  }

  if (problems.length) throw new Error(`Pull request не соответствует правилам репозитория:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  console.log(`Правила PR выполнены: ветка, описание, ${Math.floor(commits.length / 2)} коммит(ов), версии и зависимости.`);
});
