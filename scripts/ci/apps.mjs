// Select applications for GitHub Actions and check the `app` choice lists in the workflows.
// Usage: node scripts/ci/apps.mjs check
//        APP=<all|directory> DRY_RUN=<true|false> node scripts/ci/apps.mjs select
import { assertWorkflows, isDryRun, listApps, main, output, selectApps, summary } from './lib.mjs';

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
  const selected = selectApps(process.env.APP || 'all', apps);
  output(
    'apps',
    selected.map(({ dir, name }) => ({ dir, name }))
  );
  output('dry_run', String(dryRun));
  const lines = selected.map((app) => `- \`${app.dir}\` → \`${app.name}@${app.version}\``);
  console.log(`Выбранные приложения${dryRun ? ' (dry run)' : ''}:\n${lines.join('\n')}`);
  summary(`### Выбранные приложения${dryRun ? ' (dry run)' : ''}\n\n${lines.join('\n')}\n`);
});
