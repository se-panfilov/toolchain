// Plan and run npm releases from GitHub Actions.
// Usage: APP=<all|directory> DRY_RUN=<true|false> node scripts/ci/release.mjs plan
//        APP=<directory> ARCHIVE_DIR=<path> DRY_RUN=<true|false> node scripts/ci/release.mjs publish
//        APP=<directory> ARCHIVE_DIR=<path> DRY_RUN=<true|false> node scripts/ci/release.mjs github-release
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  assertReleaseRef,
  assertWorkflows,
  check,
  compareVersions,
  inspectArchive,
  isDryRun,
  listApps,
  main,
  output,
  readJson,
  registry,
  registryState,
  run,
  safe,
  selectApps,
  summary
} from './lib.mjs';

// The minimum npm version for trusted publishing through OIDC.
const minimumNpm = '11.5.1';

// Load the archive from the build job and compare it with the checked-out application.
function loadArchive(app) {
  const directory = process.env.ARCHIVE_DIR ?? '';
  if (!isAbsolute(directory)) throw new Error('ARCHIVE_DIR должен быть абсолютным путём.');
  const manifest = readJson(join(directory, 'manifest.json'));
  const filename = `${app.name}-${app.version}.tgz`;
  if (manifest.dir !== app.dir || manifest.name !== app.name || manifest.version !== app.version || manifest.filename !== filename) {
    throw new Error('manifest.json архива не совпадает с package.json приложения.');
  }
  const archive = join(directory, filename);
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Архив должен быть обычным файлом без ссылок.');
  const bytes = readFileSync(archive);
  const report = inspectArchive(bytes, app);
  if (report.integrity !== manifest.integrity) throw new Error('Контрольная сумма архива не совпадает с manifest.json.');
  return { archive, integrity: report.integrity };
}

function plan(dryRun) {
  assertReleaseRef(dryRun, process.env.GITHUB_REF ?? '');
  const apps = listApps();
  assertWorkflows(apps);
  const releases = [];
  const lines = [];
  for (const app of selectApps(process.env.APP || 'all', apps)) {
    const state = registryState(app);
    if (state.published) {
      lines.push(`- \`${app.name}@${app.version}\`: уже опубликован, пропуск`);
      console.log(`::notice::${app.name}@${app.version} уже опубликован. Пропуск.`);
      continue;
    }
    releases.push({ dir: app.dir, name: app.name, version: app.version });
    lines.push(`- \`${app.name}@${app.version}\`: ${dryRun ? 'будет проверен без публикации' : 'будет опубликован'}`);
  }
  output('releases', releases);
  output('count', String(releases.length));
  output('dry_run', String(dryRun));
  const text = `### План релиза${dryRun ? ' (dry run)' : ''}\n\n${lines.join('\n')}\n`;
  console.log(text);
  summary(text);
}

function publish(dryRun, app) {
  const { archive, integrity } = loadArchive(app);
  const npmVersion = check('npm', ['--version']).trim();
  if (!dryRun && compareVersions(npmVersion, minimumNpm) < 0) throw new Error(`Для trusted publishing нужен npm ${minimumNpm} или новее. Сейчас: ${safe(npmVersion)}.`);
  const state = registryState(app);
  if (state.published) {
    if (state.integrity !== integrity) throw new Error(`${app.name}@${app.version} уже опубликован с другим архивом. Увеличьте версию.`);
    console.log(`${app.name}@${app.version} уже опубликован с этим архивом. Пропуск публикации.`);
    return;
  }
  // A dry run has no OIDC token, so it cannot request provenance.
  const args = ['publish', archive, '--ignore-scripts', `--registry=${registry}`, '--access=public', dryRun ? '--dry-run' : '--provenance'];
  const result = run('npm', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm publish завершился с кодом ${result.status}. Проверьте реестр перед повтором.`);
  if (!dryRun) {
    const published = registryState(app);
    if (!published.published) console.log(`::warning::Реестр npm ещё не показывает ${app.name}@${app.version}. Проверьте его позже.`);
    else if (published.integrity !== integrity) throw new Error('Реестр npm показывает другую контрольную сумму архива.');
  }
  summary(`- \`${app.name}@${app.version}\`: ${dryRun ? 'npm publish --dry-run выполнен' : 'опубликован'} (\`${integrity}\`)`);
}

function githubRelease(dryRun, app) {
  const { archive, integrity } = loadArchive(app);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Нет корректных GITHUB_REPOSITORY и GITHUB_SHA.');
  const tag = `${app.name}@${app.version}`;
  const refs = JSON.parse(check('gh', ['api', `repos/${repository}/git/matching-refs/tags/${tag}`]));
  const existing = refs.find((ref) => ref.ref === `refs/tags/${tag}`);
  if (existing && existing.object?.sha !== sha) {
    // Annotated tags point to a tag object. Resolve it before comparison.
    const target = existing.object?.type === 'tag' ? JSON.parse(check('gh', ['api', `repos/${repository}/git/tags/${existing.object.sha}`])).object?.sha : existing.object?.sha;
    if (target !== sha) throw new Error(`Тег ${tag} уже указывает на другой коммит.`);
  }
  const view = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'tagName']);
  if (view.status === 0) {
    console.log(`GitHub Release ${tag} уже существует. Пропуск.`);
    return;
  }
  if (!/release not found/i.test(view.stderr ?? '')) throw new Error(`Не удалось проверить GitHub Release ${tag}.\n${safe(view.stderr)}`);
  const notes = [
    `Package: \`${app.name}@${app.version}\``,
    `Directory: \`apps/${app.dir}\``,
    `Commit: \`${sha}\``,
    `Integrity: \`${integrity}\``,
    '',
    'The attached archive is the file published to npm.'
  ].join('\n');
  const args = ['release', 'create', tag, archive, '--repo', repository, '--target', sha, '--title', tag, '--notes', notes];
  if (dryRun) {
    console.log(`[dry run] gh ${args.map((arg) => (arg === notes ? '<notes>' : arg)).join(' ')}`);
    return;
  }
  check('gh', args);
  summary(`- GitHub Release \`${tag}\` создан`);
}

await main(() => {
  const mode = process.argv[2];
  if (process.argv.length !== 3) throw new Error('Используйте: release.mjs plan | publish | github-release');
  const dryRun = isDryRun(process.env.DRY_RUN);
  if (mode === 'plan') return plan(dryRun);
  assertReleaseRef(dryRun, process.env.GITHUB_REF ?? '');
  const appName = process.env.APP ?? '';
  if (appName === 'all') throw new Error('Укажите одно приложение.');
  const [app] = selectApps(appName, listApps());
  if (mode === 'publish') return publish(dryRun, app);
  if (mode === 'github-release') return githubRelease(dryRun, app);
  throw new Error('Используйте: release.mjs plan | publish | github-release');
});
