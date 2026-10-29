// Pack one built application, inspect the archive, and run its bin from the archive.
// Usage: APP=<directory> OUT_DIR=<new directory> node scripts/ci/package.mjs
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { check, inspectArchive, listApps, main, run, safe, selectApps, summary } from './lib.mjs';

// Do not give credentials or user npm settings to the archive check.
function isolatedEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|NODE_AUTH_TOKEN$|NPM_TOKEN$|GITHUB_TOKEN$|GH_TOKEN$|ACTIONS_ID_TOKEN_)/i.test(key)));
  const userconfig = join(home, '.npmrc');
  writeFileSync(userconfig, '');
  return { ...env, HOME: home, USERPROFILE: home, npm_config_userconfig: userconfig, npm_config_cache: join(home, 'cache'), npm_config_update_notifier: 'false', NO_COLOR: '1' };
}

await main(() => {
  const apps = listApps();
  const appName = process.env.APP ?? '';
  if (appName === 'all') throw new Error('Укажите одно приложение.');
  const [app] = selectApps(appName, apps);
  const out = process.env.OUT_DIR ?? '';
  if (!isAbsolute(out)) throw new Error('OUT_DIR должен быть абсолютным путём.');
  mkdirSync(out, { recursive: false });

  const packed = JSON.parse(check('npm', ['pack', '--workspace', app.name, '--ignore-scripts', '--json', '--pack-destination', out]));
  const filename = `${app.name}-${app.version}.tgz`;
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0].filename !== filename) throw new Error('npm pack вернул неожиданный результат.');
  if (readdirSync(out).join() !== filename) throw new Error('В каталоге архива есть посторонние файлы.');
  const archive = join(out, filename);
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Архив должен быть обычным файлом без ссылок.');
  const bytes = readFileSync(archive);
  const report = inspectArchive(bytes, app);
  if (packed[0].integrity !== report.integrity) throw new Error('Контрольная сумма архива не совпадает с результатом npm pack.');

  const home = mkdtempSync(join(tmpdir(), 'toolchain-pack-'));
  try {
    const env = isolatedEnv(home);
    for (const bin of Object.keys(app.bin)) {
      const result = run('npm', ['exec', '--offline', '--yes', '--package', archive, '--', bin, '--help'], { cwd: home, env });
      if (result.status !== 0) throw new Error(`${bin} --help из архива завершился с кодом ${result.status}.\n${safe(result.stderr)}`);
      console.log(`${bin} --help из архива: OK`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const manifest = { dir: app.dir, name: app.name, version: app.version, filename, integrity: report.integrity };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Архив ${filename}: ${report.files.length} файлов, ${report.integrity}`);
  summary(`### ${app.name}@${app.version}\n\n- Архив: \`${filename}\`\n- Integrity: \`${report.integrity}\`\n- Файлы:\n${report.files.map((file) => `  - \`${file}\``).join('\n')}\n`);
});
