// Select applications for GitHub Actions and check the `app` choice lists in the workflows.
// Usage: node scripts/ci/apps.mjs check
//        APP=<all|directory> DRY_RUN=<true|false> node scripts/ci/apps.mjs select
//        EVENT=pull_request BASE_SHA=<sha> HEAD_SHA=<sha> DRY_RUN=false node scripts/ci/apps.mjs select
import { assertWorkflows, changedApps, check, isDryRun, listApps, lockfileApps, main, output, run, safe, selectApps, summary } from './lib.mjs';

const objectName = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// Read the files that a pull request changes. `--no-renames` lists both paths of a moved file.
function pullRequestChanges(baseSha, headSha, apps) {
  if (!objectName.test(baseSha) || !objectName.test(headSha)) throw new Error('BASE_SHA и HEAD_SHA должны быть полными идентификаторами коммитов.');
  const mergeBase = check('git', ['merge-base', baseSha, headSha]).trim();
  const files = check('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeBase, headSha]).split('\0').filter(Boolean);
  const lockfile = files.includes('package-lock.json') ? lockfileApps(readLock(mergeBase), readLock(headSha), apps) : undefined;
  return changedApps(files, apps, lockfile);
}

// A missing or invalid lockfile returns undefined. Then the lockfile counts as a shared file.
function readLock(commit) {
  const result = run('git', ['show', `${commit}:package-lock.json`]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

await main(() => {
  const mode = process.argv[2];
  const apps = listApps();
  assertWorkflows(apps);
  if (mode === 'check') {
    console.log(`Списки app в GitHub Actions совпадают с apps/: ${apps.map((app) => app.dir).join(', ')}.`);
    return;
  }
  if (mode !== 'select' || process.argv.length !== 3) throw new Error('Используйте: apps.mjs check | select');
  const dryRun = isDryRun(process.env.DRY_RUN);
  // A pull request keeps every application in the matrix, so each required `test (…)` check reports a result.
  // The test job skips its steps for applications that the pull request does not change.
  let matrix;
  let selected;
  let reason;
  if (process.env.EVENT === 'pull_request') {
    const result = pullRequestChanges(process.env.BASE_SHA ?? '', process.env.HEAD_SHA ?? '', apps);
    matrix = apps;
    selected = result.apps;
    reason =
      result.shared === undefined ? (selected.length === apps.length ? 'изменены все приложения' : 'изменены только эти приложения') : `изменён общий файл ${safe(result.shared).replace(/`/g, "'")}`;
  } else {
    selected = selectApps(process.env.APP || 'all', apps);
    matrix = selected;
  }
  output(
    'apps',
    matrix.map(({ dir, name }) => ({ dir, name }))
  );
  output(
    'selected',
    selected.map(({ dir }) => dir)
  );
  output('dry_run', String(dryRun));
  const lines = selected.map((app) => `- \`${app.dir}\` → \`${app.name}@${app.version}\``);
  const title = `Выбранные приложения${dryRun ? ' (dry run)' : ''}${reason ? `: ${reason}` : ''}`;
  console.log(`${title}\n${lines.join('\n')}`);
  summary(`### ${title}\n\n${lines.join('\n')}\n`);
});
