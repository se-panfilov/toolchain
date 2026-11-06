// Pack one built application, inspect the archive, and run its bin from the archive.
// Usage: APP=<directory> OUT_DIR=<new directory> node scripts/ci/package.mjs
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { check, inspectArchive, listApps, main, root, run, safe, selectApps, summary } from './lib.mjs';

// Do not give credentials or user npm settings to the archive check.
function isolatedEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|NODE_AUTH_TOKEN$|NPM_TOKEN$|GITHUB_TOKEN$|GH_TOKEN$|ACTIONS_ID_TOKEN_)/i.test(key)));
  const userconfig = join(home, '.npmrc');
  writeFileSync(userconfig, '');
  return { ...env, HOME: home, USERPROFILE: home, npm_config_userconfig: userconfig, npm_config_cache: join(home, 'cache'), npm_config_update_notifier: 'false', NO_COLOR: '1' };
}

// Find the lockfile entry that Node.js resolution selects for `name`, required from the lockfile path `from`.
function resolveLocked(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return undefined;
    const nested = base.lastIndexOf('/node_modules/');
    base = nested >= 0 ? base.slice(0, nested) : '';
  }
}

// Pack the runtime dependencies from the tree that `npm ci` installed from the lockfile.
// The archive check can then install the application without the registry.
function packDependencies(app, dest, env) {
  const packages = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages ?? {};
  const manifest = JSON.parse(readFileSync(join(root, 'apps', app.dir, 'package.json'), 'utf8'));
  const queue = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, from: `apps/${app.dir}` }));
  const keys = new Set();
  while (queue.length) {
    const { name, from } = queue.shift();
    const key = resolveLocked(packages, from, name);
    if (!key) throw new Error(`Зависимость ${name} не найдена в package-lock.json.`);
    if (keys.has(key)) continue;
    const entry = packages[key];
    if (entry.link || entry.hasInstallScript) throw new Error(`Зависимость ${name} не поддерживается: ссылка или скрипт установки.`);
    const installed = JSON.parse(readFileSync(join(root, key, 'package.json'), 'utf8'));
    if (installed.name !== name || installed.version !== entry.version) throw new Error(`Установленная зависимость ${name} не совпадает с package-lock.json.`);
    keys.add(key);
    for (const dependency of Object.keys(entry.dependencies ?? {})) queue.push({ name: dependency, from: key });
  }
  mkdirSync(dest);
  return [...keys].map((key) => {
    const packed = JSON.parse(check('npm', ['pack', join(root, key), '--ignore-scripts', '--json', '--pack-destination', dest], { cwd: dest, env }));
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== 'string') throw new Error('npm pack вернул неожиданный результат.');
    return join(dest, packed[0].filename);
  });
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
    // Install the archive with its locked runtime dependencies, without the registry and without scripts.
    const dependencies = packDependencies(app, join(home, 'deps'), env);
    const project = join(home, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), '{ "private": true }\n');
    check('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', archive, ...dependencies], { cwd: project, env });
    for (const bin of Object.keys(app.bin)) {
      const result = run('npm', ['exec', '--offline', '--no', '--', bin, '--help'], { cwd: project, env });
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
