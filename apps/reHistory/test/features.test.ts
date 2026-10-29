import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Repository, runGit, makePlan, applyPlan } from '@reHistory/engine';
import { auditRepository, stamp } from '@reHistory/audit';
import { exportDestination, exportPlan, verifyExport, manifestName } from '@reHistory/export';
import { runDemo, validateDemoURL } from '@reHistory/demo';
import { parseArguments } from '@reHistory/cli';

function temp(t: { onTestFinished: (fn: () => void) => void }): string {
  const path = mkdtempSync(join(tmpdir(), 'rehistory-features-'));
  t.onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function fixture(t: { onTestFinished: (fn: () => void) => void }, format = 'sha1'): Repository {
  const root = temp(t);
  runGit(root, ['init', '-q', '--template=', '--initial-branch=main', `--object-format=${format}`, join(root, 'source')]);
  const repo = new Repository(join(root, 'source'));
  repo.git(['config', 'user.name', 'Исходный автор']);
  repo.git(['config', 'user.email', 'old@example.org']);
  writeFileSync(join(repo.path, 'data.bin'), Buffer.from([0, 10, 255, 127]));
  repo.git(['add', '--', 'data.bin']);
  repo.git(['commit', '-q', '-m', 'Сообщение 2020-01-01'], undefined, { GIT_AUTHOR_DATE: '1600000000 +0300', GIT_COMMITTER_DATE: '1600000002 +0300' });
  repo.git(['tag', 'light']);
  repo.git(['tag', '-a', '-m', 'Annotated', 'annotated'], undefined, { GIT_COMMITTER_DATE: '1600000005 +0300' });
  repo.git(['tag', '-a', '-m', 'Nested', 'nested', 'annotated'], undefined, { GIT_COMMITTER_DATE: '1600000007 -0200' });
  return repo;
}
function snapshot(path: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result.set(file, readFileSync(file));
    }
  }
  walk(path);
  return result;
}
const settings = { start: 1700000000, interval: 2 };

for (const format of ['sha1', 'sha256'])
  test(`проверка экспорта ${format} не подменяет каталог родительским Git-репозиторием`, (t) => {
    const repo = fixture(t, format);
    const target = join(repo.path, '..', 'discovery.git');
    exportPlan(makePlan(repo, settings), target);
    const child = join(target, 'nested');
    mkdirSync(child);
    writeFileSync(join(child, manifestName), readFileSync(join(target, manifestName)));
    const before = snapshot(target);
    const report = verifyExport(child);
    assert.equal(report.ok, false);
    assert(report.errors.some((error) => error.includes('Отсутствует')));
    assert.deepEqual(snapshot(target), before);
  });

test('проверка экспорта требует собственные HEAD, config, objects и refs', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'required-layout.git');
  exportPlan(makePlan(repo, settings), target);
  for (const missing of ['HEAD', 'config', 'objects', 'refs']) {
    const child = join(target, `missing-${missing}`);
    mkdirSync(child);
    writeFileSync(join(child, manifestName), readFileSync(join(target, manifestName)));
    for (const name of ['HEAD', 'config']) if (name !== missing) writeFileSync(join(child, name), readFileSync(join(target, name)));
    for (const name of ['objects', 'refs']) if (name !== missing) mkdirSync(join(child, name));
    const before = snapshot(target);
    const result = verifyExport(child);
    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes(`элемент экспорта: ${missing}.`)));
    assert.deepEqual(snapshot(target), before);
  }
});

test('dangling symbolic refs видны в аудите и блокируют переписывание локальных веток и тегов', (t) => {
  const repo = fixture(t);
  for (const name of ['refs/heads/dangling', 'refs/tags/dangling']) {
    const file = join(repo.common, name);
    writeFileSync(file, 'ref: refs/heads/missing\n');
    const before = snapshot(repo.path);
    const report = auditRepository(repo);
    assert.equal(report.complete, false);
    assert(report.refs.some((ref) => ref.name === name && ref.symbolic === 'refs/heads/missing'));
    assert.throws(() => makePlan(repo, settings), /Символические ссылки/);
    assert.deepEqual(snapshot(repo.path), before);
    rmSync(file);
  }
});

test('экспорт отвергает посторонние файлы и каталоги внутри objects и refs', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'nested-check.git');
  exportPlan(makePlan(repo, settings), target);
  for (const relative of ['objects/info/recovery-private.json', 'objects/pack/private.keep', 'objects/ff/notes.txt', 'refs/heads/main.lock']) {
    const file = join(target, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'source-path=/private/project; old-date=2000-01-01\n');
    const before = snapshot(target);
    assert.equal(verifyExport(target).ok, false, relative);
    assert.deepEqual(snapshot(target), before);
    rmSync(file);
  }
  mkdirSync(join(target, 'objects', 'info', 'private'));
  assert.equal(verifyExport(target).ok, false);
});

test('экспорт отвергает посторонние данные в config, HEAD и манифесте', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'metadata-check.git');
  exportPlan(makePlan(repo, settings), target);
  for (const file of ['config', 'HEAD']) {
    const path = join(target, file);
    const before = readFileSync(path);
    writeFileSync(path, Buffer.concat([before, Buffer.from('# source-path=/private/project\n')]));
    assert.equal(verifyExport(target).ok, false, file);
    writeFileSync(path, before);
  }
  const path = join(target, manifestName);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.sourcePath = '/private/project';
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => verifyExport(target), /манифест/);
});

test('схема манифеста отвергает неверные типы, дубликаты и дополнительные поля', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'schema-check.git');
  exportPlan(makePlan(repo, settings), target);
  const file = join(target, manifestName);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  const cases = [
    null,
    [],
    1,
    { ...original, refs: [null] },
    { ...original, policy: null },
    { ...original, objects: [...original.objects, original.objects[0]] },
    { ...original, refs: [...original.refs, original.refs[0]] },
    { ...original, commitOrder: [...original.commitOrder, original.commitOrder[0]] },
    { ...original, policy: { ...original.policy, identity: { name: 'Test', email: 'test@example.org', sourcePath: '/private' } } },
    { ...original, policy: { ...original.policy, sourcePath: '/private' } },
    { ...original, policy: { ...original.policy, identity: null } }
  ];
  for (const value of cases) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => verifyExport(target), /манифест/);
  }
  writeFileSync(file, JSON.stringify(original));
  assert.equal(verifyExport(target).ok, true);
});

for (const format of ['sha1', 'sha256'])
  test(`проверяются pack/idx и packed-refs ${format}, посторонние данные отвергаются`, (t) => {
    const repo = fixture(t, format);
    const target = join(repo.path, '..', 'packed-check.git');
    exportPlan(makePlan(repo, settings), target);
    const output = new Repository(target);
    output.git(['-c', 'repack.writeBitmaps=false', '-c', 'pack.writeReverseIndex=false', 'repack', '-adn']);
    output.git(['pack-refs', '--all', '--prune']);
    assert.equal(verifyExport(target).ok, true);
    const file = join(target, 'packed-refs');
    const original = readFileSync(file, 'utf8');
    for (const oid of [repo.text(['rev-parse', 'HEAD']), output.text(['rev-parse', 'HEAD^{tree}'])]) {
      writeFileSync(file, original.replace(/^\^[a-f0-9]+$/m, `^${oid}`));
      assert.equal(verifyExport(target).ok, false, 'подменённый cached peeled OID');
    }
    writeFileSync(file, original);
    writeFileSync(file, original.replace('\n', ' source-path=/private/project\n'));
    assert.equal(verifyExport(target).ok, false);
    writeFileSync(file, original);
    const pack = readdirSync(join(target, 'objects', 'pack')).find((name) => name.endsWith('.pack'))!;
    const keep = join(target, 'objects', 'pack', pack.replace(/\.pack$/, '.keep'));
    writeFileSync(keep, 'private metadata');
    assert.equal(verifyExport(target).ok, false);
    rmSync(keep);
    const idx = join(target, 'objects', 'pack', pack.replace(/\.pack$/, '.idx'));
    const index = readFileSync(idx);
    rmSync(idx);
    assert.equal(verifyExport(target).ok, false);
    writeFileSync(idx, index);
    assert.equal(verifyExport(target).ok, true);
    const renamed = pack.replace(/^pack-[a-f0-9]+/, `pack-${repo.text(['rev-parse', 'HEAD'])}`);
    const renamedPack = join(target, 'objects', 'pack', renamed);
    const renamedIdx = renamedPack.replace(/\.pack$/, '.idx');
    renameSync(join(target, 'objects', 'pack', pack), renamedPack);
    renameSync(idx, renamedIdx);
    assert.equal(verifyExport(target).ok, false, 'имя pack не совпадает с checksum');
    renameSync(renamedPack, join(target, 'objects', 'pack', pack));
    renameSync(renamedIdx, idx);
    assert.equal(verifyExport(target).ok, true);
  });

test('аудит читает stash, скрытые ссылки и исходную историю; побайтово ничего не меняет', (t) => {
  const repo = fixture(t);
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'Side']);
  repo.git(['tag', 'side-tag']);
  repo.git(['checkout', '-q', 'main']);
  repo.git(['update-ref', 'refs/stash', repo.text(['rev-parse', 'side'])]);
  repo.git(['update-ref', 'refs/hidden/test', repo.text(['rev-parse', 'side'])]);
  repo.git(['hash-object', '-w', '--stdin'], 'orphan blob');
  writeFileSync(join(repo.path, 'untracked'), 'не мешает аудиту');
  const before = snapshot(repo.path);
  const report = auditRepository(repo);
  assert.equal(report.complete, true);
  assert(report.refs.some((r) => r.name === 'refs/stash'));
  assert(report.refs.some((r) => r.name === 'refs/hidden/test' && !r.inCurrentHistory));
  assert(report.tags.some((tag) => tag.tagger.timezone === '-0200'));
  assert(report.commits.some((c) => !c.inCurrentHistory));
  assert(report.reflog.entries > 0);
  assert(report.unreachable.byType.blob > 0);
  assert.deepEqual(snapshot(repo.path), before);
});

test('нормализуются даты и tagger вложенных тегов, есть режим сохранения', (t) => {
  const repo = fixture(t);
  const original = repo.git(['cat-file', 'tag', 'annotated']);
  const preserved = makePlan(repo, { ...settings, tagPolicy: 'preserve' });
  assert.deepEqual(stamp(preserved.objects.find((o) => o.oid === preserved.mapping.get(repo.text(['rev-parse', 'annotated'])))!.data, 'tagger'), stamp(original, 'tagger'));
  applyPlan(makePlan(repo, { ...settings, tagIdentity: { name: 'Новый', email: 'new@example.org' } }));
  for (const name of ['annotated', 'nested']) {
    const tagger = stamp(repo.git(['cat-file', 'tag', name]), 'tagger');
    assert.deepEqual(tagger, { identity: 'Новый <new@example.org>', timestamp: settings.start, timezone: '+0000' });
  }
});

for (const format of ['sha1', 'sha256'])
  test(`экспорт ${format}: исходник неизменен, нет старых коммитов/тегов, файловые данные сохранены`, (t) => {
    const repo = fixture(t, format);
    repo.git(['checkout', '-q', '-b', 'side']);
    repo.git(['commit', '-q', '--allow-empty', '-m', 'Исключённый']);
    repo.git(['tag', '-a', '-m', 'side', 'side-tag']);
    repo.git(['checkout', '-q', 'main']);
    repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD'])]);
    const plan = makePlan(repo, settings);
    const before = snapshot(repo.path);
    const target = join(repo.path, '..', 'export.git');
    assert.equal(exportPlan(plan, target).ok, true);
    assert.deepEqual(snapshot(repo.path), before);
    const output = new Repository(target);
    const audit = auditRepository(output);
    assert.equal(audit.complete, true);
    assert.equal(audit.reflog.entries, 0);
    assert.equal(audit.unreachable.count, 0);
    assert(!audit.refs.some((r) => r.name.includes('side') || r.name.includes('origin') || r.backup));
    const oldObjects = plan.objects.map((o) => [...plan.mapping].find(([, next]) => next === o.oid)![0]);
    assert(!audit.commits.some((c) => oldObjects.includes(c.oid)));
    assert(!audit.tags.some((tag) => oldObjects.includes(tag.oid)));
    assert.deepEqual(output.git(['show', 'HEAD:data.bin']), Buffer.from([0, 10, 255, 127]));
    assert.equal(output.text(['log', '-1', '--format=%B']), 'Сообщение 2020-01-01');
    const manifest = readFileSync(join(target, manifestName), 'utf8');
    assert(!manifest.includes(repo.path));
    assert(!manifest.includes('side-tag'));
    assert(!oldObjects.some((oid) => manifest.includes(oid)));
    const verificationBefore = snapshot(target);
    assert.equal(verifyExport(target).ok, true);
    assert.deepEqual(snapshot(target), verificationBefore);
  });

test('проверка экспорта обнаруживает лишний объект и постороннюю ссылку', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'export.git');
  exportPlan(makePlan(repo, settings), target);
  const output = new Repository(target);
  const blob = output.text(['hash-object', '-w', '--stdin'], 'unexpected');
  let report = verifyExport(target);
  assert.equal(report.ok, false);
  assert(report.errors.some((e) => e.includes(`objects/${blob.slice(0, 2)}/${blob.slice(2)}`)));
  output.git(['update-ref', 'refs/tags/unexpected', blob]);
  report = verifyExport(target);
  assert.equal(report.ok, false);
  assert(report.errors.some((e) => e.includes('refs/tags/unexpected')));
});

test('проверка экспорта выявляет неверную дату tagger и отсутствие манифеста', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'export.git');
  exportPlan(makePlan(repo, settings), target);
  const output = new Repository(target);
  const original = output.git(['cat-file', 'tag', 'annotated']);
  const raw = Buffer.from(original.toString('utf8').replace(`${settings.start} +0000`, '1600000000 +0000'));
  const oid = output.text(['hash-object', '-w', '-t', 'tag', '--stdin'], raw);
  output.git(['update-ref', 'refs/tags/annotated', oid]);
  // Keep the inventory and refs consistent so the date check is exercised.
  const file = join(target, manifestName);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.refs.find((ref: { name: string }) => ref.name === 'refs/tags/annotated').oid = oid;
  manifest.objects.push(oid);
  writeFileSync(file, JSON.stringify(manifest));
  assert(verifyExport(target).errors.some((e) => e.includes('дата тега')));
  rmSync(join(target, manifestName));
  assert.throws(() => verifyExport(target));
});

test('экспорт не перезаписывает каталоги/символические ссылки и не пишет внутрь source', (t) => {
  const repo = fixture(t);
  const plan = makePlan(repo, settings);
  const before = snapshot(repo.path);
  assert.throws(() => exportPlan(plan, repo.path), /уже существует/);
  assert.throws(() => exportPlan(plan, join(repo.path, 'new')), /вне исходного/);
  const target = join(repo.path, '..', 'symlink');
  symlinkSync(repo.path, target, 'dir');
  assert.throws(() => exportPlan(plan, target), /уже существует/);
  const unused = join(repo.path, '..', 'unused');
  exportDestination(repo, unused);
  assert.equal(existsSync(unused), false);
  assert.deepEqual(snapshot(repo.path), before);
});

test('конкурирующее изменение source останавливает экспорт до создания каталога', (t) => {
  const repo = fixture(t);
  const plan = makePlan(repo, settings);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'new']);
  const target = join(repo.path, '..', 'export.git');
  assert.throws(() => exportPlan(plan, target), /изменился/);
  assert.equal(existsSync(target), false);
});

test('demo: URL обязателен; опасные URL и несовместимые параметры отвергаются', (t) => {
  const root = temp(t);
  const directory = join(root, 'must-not-exist');
  const cli = spawnSync(process.execPath, [new URL('../dist/src/cli.js', import.meta.url).pathname, '--demo', '--demo-dir', directory]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr.toString(), /обязателен/);
  assert.equal(existsSync(directory), false);
  for (const url of [
    '',
    '/tmp/server.git',
    'file:///tmp/server.git',
    'ext::sh -c id',
    'http://example.org/repo',
    'https://token@example.org/repo',
    'https://example.org/repo?secret=1',
    'ssh://-bad@example.org/repo',
    'https://example.org/a\n'
  ])
    assert.throws(() => validateDemoURL(url));
  assert.equal(validateDemoURL('git@example.org:owner/repo.git'), 'git@example.org:owner/repo.git');
  for (const args of [['--demo'], ['--audit', '--export', '/tmp/x'], ['--json'], ['--repo', '/tmp/x', '--verify-export', '/tmp/y'], ['--demo-remote', 'https://example.org/repo']])
    assert.throws(() => parseArguments(args));
});

test('demo отказывает для непустого сервера до создания файлов и push', (t) => {
  const root = temp(t);
  const directory = join(root, 'demo');
  let pushes = 0;
  assert.throws(
    () =>
      runDemo(
        { remote: 'https://example.invalid/used.git', directory },
        {
          refs: () => 'old refs/heads/main',
          push: () => {
            pushes++;
          }
        }
      ),
    /пустой/
  );
  assert.equal(pushes, 0);
  assert.equal(existsSync(directory), false);
});

test('полный demo с адаптером транспорта: реальные push, аудит, экспорт и проверка', (t) => {
  const root = temp(t);
  const server = join(root, 'test-server.git');
  // The server belongs to this test only. The product does not create it.
  runGit(root, ['init', '-q', '--bare', '--template=', server]);
  let pushes = 0;
  const result = runDemo(
    { remote: 'https://example.invalid/empty.git', directory: join(root, 'demo') },
    {
      refs: (repo) => repo.text(['-c', 'protocol.file.allow=always', 'ls-remote', '--refs', server]),
      push: (repo, _url, refs) => {
        pushes++;
        repo.git(['-c', 'protocol.file.allow=always', 'push', '--atomic', '--', server, ...refs]);
      }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(pushes, 2);
  assert.equal(result.originalCommits, 16);
  assert.equal(result.exported.commits, 10);
  assert.equal(result.exported.tags, 3);
  assert.deepEqual(readdirSync(result.root).sort(), ['demo-result.json', 'export.git', 'source']);
  const serverRepo = new Repository(server);
  assert.equal(serverRepo.refs().filter((r) => r.name.startsWith('refs/heads/')).length, 4);
  assert.equal(serverRepo.refs().filter((r) => r.name.startsWith('refs/tags/')).length, 9);
  assert(!serverRepo.refs().some((r) => r.name.includes('backup')));
  assert.equal(verifyExport(result.exported.repository).ok, true);
});

test('проверка экспорта отвергает посторонние служебные файлы', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'export.git');
  exportPlan(makePlan(repo, settings), target);
  writeFileSync(join(target, 'rehistory-recovery-old.json'), '{}');
  assert(verifyExport(target).errors.some((e) => e.includes('Неожиданный служебный')));
});

test('вне явного сетевого адаптера сетевые и файловые Git-транспорты запрещены', (t) => {
  const repo = fixture(t);
  assert.throws(() => repo.git(['ls-remote', 'https://example.invalid/repo.git']), /not allowed/);
  assert.throws(() => repo.git(['ls-remote', repo.path]), /not allowed/);
});

test('CLI запускается через символическую ссылку, как npm bin', (t) => {
  const root = temp(t);
  const link = join(root, 'tx-rehistory.js');
  symlinkSync(new URL('../dist/src/cli.js', import.meta.url).pathname, link);
  const result = spawnSync(process.execPath, [link, '--help']);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /--demo-remote/);
});

test('проверка экспорта отвергает дополнительные персональные настройки config', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'export.git');
  exportPlan(makePlan(repo, settings), target);
  new Repository(target).git(['config', 'user.email', 'extra@example.org']);
  assert(verifyExport(target).errors.some((e) => e.includes('посторонние настройки')));
});

test('refs/codex/* сохраняются при переписывании и не попадают в экспорт', (t) => {
  const repo = fixture(t);
  const checkpoint = 'refs/codex/turn-diffs/checkpoints/session/turn/1793225263690/checkpoint';
  const original = repo.text(['rev-parse', 'HEAD']);
  repo.git(['update-ref', checkpoint, original]);
  const plan = makePlan(repo, settings);
  assert(!plan.selected.some((r) => r.name.startsWith('refs/codex/')));
  applyPlan(plan);
  assert.equal(repo.text(['rev-parse', checkpoint]), original);
  assert.notEqual(repo.text(['rev-parse', 'HEAD']), original);
  const audit = auditRepository(repo);
  assert(audit.refs.some((r) => r.name === checkpoint && !r.inCurrentHistory));
  const target = join(repo.path, '..', 'export.git');
  assert.equal(exportPlan(makePlan(repo, settings), target).ok, true);
  assert(!new Repository(target).refs().some((r) => r.name.startsWith('refs/codex/')));
});

test('refs/codex без разделителя пространства имён не разрешает посторонние refs', (t) => {
  const repo = fixture(t);
  repo.git(['update-ref', 'refs/codex-untrusted/test', repo.text(['rev-parse', 'HEAD'])]);
  assert.throws(() => makePlan(repo, settings), /Неподдерживаемые/);
});
