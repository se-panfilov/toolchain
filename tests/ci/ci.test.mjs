import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertReleaseRef,
  changedApps,
  inspectArchive,
  integrity,
  isDryRun,
  listApps,
  lockfileApps,
  parseRegistryView,
  root,
  selectApps,
  workflowChoices,
  workflowProblems,
  workflows
} from '../../scripts/ci/lib.mjs';

const app = { dir: 'demoApp', name: 'tx-demoapp', version: '1.2.3', bin: { 'tx-demoapp': 'dist/cli.js' } };

function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function appsFixture(t, entries) {
  const base = temporary(t, 'toolchain-ci-apps-');
  for (const [dir, manifest] of Object.entries(entries)) {
    mkdirSync(join(base, 'apps', dir), { recursive: true });
    writeFileSync(join(base, 'apps', dir, 'package.json'), JSON.stringify(manifest));
  }
  return base;
}

// Make an archive with the system tar, in the same layout as npm pack.
function archive(t, files, extra = () => {}) {
  const base = temporary(t, 'toolchain-ci-tar-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(base, 'package', path, '..'), { recursive: true });
    writeFileSync(join(base, 'package', path), content);
  }
  extra(join(base, 'package'));
  // macOS tar adds AppleDouble `._*` entries unless COPYFILE_DISABLE is set. The inspection correctly rejects them.
  const result = spawnSync('tar', ['-czf', join(base, 'out.tgz'), '-C', base, 'package'], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(join(base, 'out.tgz'));
}

const goodFiles = { 'package.json': JSON.stringify({ name: app.name, version: app.version, bin: app.bin }), 'dist/cli.js': '#!/usr/bin/env node\nconsole.log(1);\n' };
const posixOnly = { skip: process.platform === 'win32' ? 'tar and symbolic links differ on Windows' : false };

test('repository applications match every workflow choice list', () => {
  const apps = listApps();
  assert.ok(apps.some((item) => item.dir === 'reHistory' && item.name === 'tx-rehistory'));
  assert.deepEqual(workflowProblems(apps), []);
  for (const file of workflows) assert.deepEqual(workflowChoices(readFileSync(join(root, file), 'utf8')), ['all', ...apps.map((item) => item.dir)]);
});

test('a missing, extra, or reordered application choice is reported', (t) => {
  const apps = listApps();
  const base = temporary(t, 'toolchain-ci-workflows-');
  cpSync(join(root, '.github'), join(base, '.github'), { recursive: true });
  const [first, second, third] = workflows.map((file) => join(base, file));
  writeFileSync(first, readFileSync(first, 'utf8').replace('          - reHistory\n', ''));
  writeFileSync(second, readFileSync(second, 'utf8').replace('          - reHistory\n', '          - reHistory\n          - oldApp\n'));
  // Move `all` below the first application, whichever application is first.
  writeFileSync(third, readFileSync(third, 'utf8').replace(/( {10}- all\n)( {10}- \S+\n)/, '$2$1'));
  const problems = workflowProblems(apps, base);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /нет reHistory/);
  assert.match(problems[1], /лишние oldApp/);
  assert.match(problems[2], /в этом порядке/);
});

test('release publication waits for a successful secret scan', () => {
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /\n {2}secrets:\n(?: {4}.*\n)*? {4}uses: \.\/\.github\/workflows\/secrets\.yml\n/);
  for (const job of ['publish-dry-run', 'publish']) assert.match(release, new RegExp(`\\n {2}${job}:\\n {4}needs: \\[[^\\]]*\\bsecrets\\b[^\\]]*\\]`), job);
  assert.match(readFileSync(join(root, '.github/workflows/secrets.yml'), 'utf8'), /\n {2}workflow_call:\n/);
});

test('workflow choice parsing rejects flow lists and missing inputs', () => {
  assert.throws(() => workflowChoices('on:\n  push:\n'), /workflow_dispatch/);
  assert.throws(() => workflowChoices('on:\n  workflow_dispatch:\n    inputs:\n      app:\n        type: string\n'), /choice/);
  assert.throws(() => workflowChoices('on:\n  workflow_dispatch:\n    inputs:\n      app:\n        type: choice\n        options:\n          - [all, x]\n'), /простые значения/);
});

test('application selection accepts only all or an exact directory name', () => {
  const apps = [app];
  assert.deepEqual(selectApps('all', apps), apps);
  assert.deepEqual(selectApps('demoApp', apps), apps);
  for (const value of ['demoapp', 'tx-demoapp', '../demoApp', 'demoApp; rm -rf /', '$(id)', 'demoApp\n', '', ' all', 'other']) {
    assert.throws(() => selectApps(value, apps), undefined, JSON.stringify(value));
  }
});

test('pull request selection tests only changed applications unless a shared file changes', () => {
  const apps = [app, { ...app, dir: 'otherApp', name: 'tx-otherapp' }, { ...app, dir: 'thirdApp', name: 'tx-thirdapp' }];
  const dirs = (files) => changedApps(files, apps).apps.map((item) => item.dir);
  assert.deepEqual(dirs(['apps/demoApp/src/cli.ts']), ['demoApp']);
  assert.deepEqual(dirs(['apps/otherApp/README.md', 'apps/demoApp/package.json', 'apps/otherApp/test/a.test.ts']), ['demoApp', 'otherApp']);
  for (const shared of [
    'package-lock.json',
    'configs/vite.config.mjs',
    '.github/workflows/test.yml',
    'scripts/ci/lib.mjs',
    'docs/WRITING.md',
    'apps/removedApp/src/cli.ts',
    'apps/demoapp/src/cli.ts',
    'apps/README.md',
    'apps/demoApp'
  ]) {
    assert.deepEqual(changedApps(['apps/demoApp/src/cli.ts', shared], apps), { apps, shared }, shared);
  }
  assert.deepEqual(changedApps([], apps), { apps, shared: undefined });
});

test('a lockfile change selects only applications whose own entries change', () => {
  const apps = [app, { ...app, dir: 'otherApp', name: 'tx-otherapp' }];
  const lock = (packages, extra = {}) => ({ name: 'toolchain', lockfileVersion: 3, packages: { '': { name: 'toolchain' }, 'node_modules/vite': { version: '1.0.0' }, ...packages }, ...extra });
  const base = lock({ 'apps/demoApp': { version: '1.0.0' }, 'apps/otherApp': { version: '2.0.0' } });
  assert.deepEqual(lockfileApps(base, lock({ 'apps/demoApp': { version: '1.0.1' }, 'apps/otherApp': { version: '2.0.0' } }), apps), ['demoApp']);
  assert.deepEqual(lockfileApps(base, lock({ 'apps/demoApp': { version: '1.0.0' }, 'apps/otherApp': { version: '2.0.0' }, 'apps/otherApp/node_modules/x': { version: '1.0.0' } }), apps), ['otherApp']);
  for (const head of [
    lock({ 'apps/demoApp': { version: '1.0.1' }, 'apps/otherApp': { version: '2.0.0' }, 'node_modules/new': { version: '1.0.0' } }),
    lock({ 'apps/demoApp': { version: '1.0.0' }, 'apps/otherApp': { version: '2.0.0' }, 'apps/removedApp': { version: '1.0.0' } }),
    lock({ 'apps/demoApp': { version: '1.0.0' }, 'apps/otherApp': { version: '2.0.0' } }, { lockfileVersion: 4 }),
    undefined,
    []
  ]) {
    assert.equal(lockfileApps(base, head, apps), undefined, JSON.stringify(head));
  }
  assert.deepEqual(changedApps(['package-lock.json', 'apps/demoApp/package.json'], apps, ['demoApp']).apps, [app]);
  assert.deepEqual(changedApps(['package-lock.json', 'apps/demoApp/package.json'], apps, undefined), { apps, shared: 'package-lock.json' });
});

test('pull request selection rejects commit names that are not full object names', () => {
  for (const sha of ['', 'HEAD', 'master', '--output=x', 'abc123']) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/ci/apps.mjs'), 'select'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, EVENT: 'pull_request', BASE_SHA: sha, HEAD_SHA: sha, DRY_RUN: 'false' }
    });
    assert.equal(result.status, 1, sha);
    assert.match(result.stderr, /BASE_SHA/);
  }
});

test('application metadata must follow the package rules', (t) => {
  const good = { name: 'tx-demoapp', version: '1.0.0', bin: { 'tx-demoapp': 'dist/cli.js' } };
  assert.deepEqual(
    listApps(appsFixture(t, { demoApp: good })).map((item) => item.name),
    ['tx-demoapp']
  );
  assert.throws(() => listApps(appsFixture(t, { demoApp: { ...good, name: 'demoapp' } })), /tx-demoapp/);
  assert.throws(() => listApps(appsFixture(t, { demoApp: { ...good, private: true } })), /private/);
  assert.throws(() => listApps(appsFixture(t, { demoApp: { ...good, version: '1.0.0-beta.1' } })), /X\.Y\.Z/);
  assert.throws(() => listApps(appsFixture(t, { demoApp: { ...good, bin: { 'tx-demoapp': '../outside.js' } } })), /bin/);
  assert.throws(() => listApps(appsFixture(t, { 'demo app': good })), /имя каталога/);
});

test('application directories that differ only in case are rejected', (t) => {
  const good = { name: 'tx-demoapp', version: '1.0.0', bin: { 'tx-demoapp': 'dist/cli.js' } };
  const base = appsFixture(t, { demoApp: good });
  // A case-insensitive file system, the macOS default, cannot hold both directories.
  if (existsSync(join(base, 'apps', 'demoapp'))) {
    t.skip('the file system does not distinguish letter case');
    return;
  }
  mkdirSync(join(base, 'apps', 'demoapp'));
  writeFileSync(join(base, 'apps', 'demoapp', 'package.json'), JSON.stringify(good));
  assert.throws(() => listApps(base), /регистра/);
});

test('a linked application directory is rejected', posixOnly, (t) => {
  const base = appsFixture(t, { demoApp: { name: 'tx-demoapp', version: '1.0.0', bin: { 'tx-demoapp': 'dist/cli.js' } } });
  symlinkSync(join(base, 'apps', 'demoApp'), join(base, 'apps', 'linked'));
  assert.throws(() => listApps(base), /только каталоги/);
});

test('dry run and release ref values are strict', () => {
  assert.equal(isDryRun('true'), true);
  assert.equal(isDryRun('false'), false);
  assert.throws(() => isDryRun('yes'));
  assert.doesNotThrow(() => assertReleaseRef(true, 'refs/heads/feature'));
  assert.doesNotThrow(() => assertReleaseRef(false, 'refs/heads/master'));
  assert.throws(() => assertReleaseRef(false, 'refs/heads/feature'), /refs\/heads\/master/);
  assert.throws(() => assertReleaseRef(false, 'refs/tags/v1'), /refs\/heads\/master/);
});

test('registry responses are interpreted without guessing', () => {
  assert.deepEqual(parseRegistryView(0, ''), { published: false });
  assert.deepEqual(parseRegistryView(0, '"sha512-abc"\n'), { published: true, integrity: 'sha512-abc' });
  assert.deepEqual(parseRegistryView(1, JSON.stringify({ error: { code: 'E404' } })), { published: false });
  assert.throws(() => parseRegistryView(1, JSON.stringify({ error: { code: 'ECONNRESET' } })), /остановлена/);
  assert.throws(() => parseRegistryView(1, 'not json'), /остановлена/);
  assert.throws(() => parseRegistryView(0, '"md5-abc"'), /неожиданный/);
});

test('a correct archive passes inspection', posixOnly, (t) => {
  const bytes = archive(t, goodFiles);
  const report = inspectArchive(bytes, app);
  assert.deepEqual(report.files, ['package/dist/cli.js', 'package/package.json']);
  assert.equal(report.integrity, integrity(bytes));
});

test('archive inspection rejects unsafe or inconsistent contents', posixOnly, (t) => {
  const cases = [
    [{ ...goodFiles, 'package.json': JSON.stringify({ name: 'tx-other', version: app.version, bin: app.bin }) }, /Имя или версия/],
    [{ ...goodFiles, 'package.json': JSON.stringify({ name: app.name, version: '9.9.9', bin: app.bin }) }, /Имя или версия/],
    [{ ...goodFiles, 'package.json': JSON.stringify({ name: app.name, version: app.version, bin: app.bin, scripts: { postinstall: 'x' } }) }, /postinstall/],
    [{ 'package.json': goodFiles['package.json'] }, /точки входа/],
    [{ ...goodFiles, 'dist/cli.js': 'console.log(1);\n' }, /#!\/usr\/bin\/env node/],
    [{ ...goodFiles, '.npmrc': 'registry=x\n' }, /секреты/],
    [{ ...goodFiles, 'dist/key.pem': 'x' }, /секреты/],
    [{ ...goodFiles, 'dist/data.js': `export const token = '${'gh' + 'p_' + 'a'.repeat(36)}';\n` }, /похожий на секрет/]
  ];
  for (const [files, pattern] of cases) assert.throws(() => inspectArchive(archive(t, files), app), pattern);
  assert.throws(
    () =>
      inspectArchive(
        archive(t, goodFiles, (directory) => symlinkSync('/etc/passwd', join(directory, 'dist/link.js'))),
        app
      ),
    /недопустимого типа/
  );
});

test('a changed archive fails integrity and header checks', posixOnly, (t) => {
  const bytes = archive(t, goodFiles);
  const changed = Buffer.from(bytes);
  changed[changed.length - 12] ^= 0xff;
  assert.throws(() => inspectArchive(changed, app));
  assert.notEqual(integrity(changed), integrity(bytes));
});
