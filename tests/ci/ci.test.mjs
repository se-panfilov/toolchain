import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertReleaseRef, inspectArchive, integrity, isDryRun, listApps, parseRegistryView, root, selectApps, workflowChoices, workflowProblems, workflows } from '../../scripts/ci/lib.mjs';

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
  const result = spawnSync('tar', ['-czf', join(base, 'out.tgz'), '-C', base, 'package'], { encoding: 'utf8' });
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
  writeFileSync(third, readFileSync(third, 'utf8').replace('          - all\n          - reHistory\n', '          - reHistory\n          - all\n'));
  const problems = workflowProblems(apps, base);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /нет reHistory/);
  assert.match(problems[1], /лишние oldApp/);
  assert.match(problems[2], /в этом порядке/);
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
  assert.throws(() => listApps(appsFixture(t, { demoApp: good, demoapp: good })), /регистра/);
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
