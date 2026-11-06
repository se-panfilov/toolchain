import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Repository, makePlan, applyPlan, validateIdentity, runGit, defaultBackupBranch, withoutGitEnvironment, stripTagSignature } from '@reHistory/engine';
import { parseDate, parseStart } from '@reHistory/cli';

function fixture(t: { onTestFinished: (fn: () => void) => void }, format?: string): Repository {
  const dir = mkdtempSync(join(tmpdir(), 'rehistory-test-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  // Isolate fixture creation from GIT_* variables and user templates too.
  runGit(tmpdir(), ['init', '-q', '--template=', '-b', 'main', ...(format ? [`--object-format=${format}`] : []), dir]);
  const repo = new Repository(dir);
  repo.git(['config', 'user.name', 'Тестовый автор']);
  repo.git(['config', 'user.email', 'test@example.org']);
  commit(repo, 'первый'); return repo;
}
function commit(repo: Repository, message: string): string {
  repo.git(['commit', '-q', '--allow-empty', '-m', message]);
  return repo.text(['rev-parse', 'HEAD']);
}
const options = { start: 1700000000, interval: 1 };
function snapshot(repo: Repository): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result.set(path, readFileSync(path));
    }
  }
  walk(repo.common); return result;
}

test('merge-граф, содержимое, сообщения, другие ветки и соответствующие теги', t => {
  const repo = fixture(t);
  const root = repo.text(['rev-parse', 'HEAD']);
  repo.git(['tag', 'root']);
  repo.git(['checkout', '-q', '-b', 'feature']);
  commit(repo, 'ответвление');
  repo.git(['checkout', '-q', 'main']);
  writeFileSync(join(repo.path, 'данные.bin'), Buffer.from([0, 255, 10, 42]));
  repo.git(['add', '--', 'данные.bin']);
  commit(repo, 'основная');
  repo.git(['merge', '--no-ff', '-q', '-m', 'слияние', 'feature']);
  repo.git(['tag', '-a', 'release', '-m', 'релиз']);
  repo.git(['tag', '-a', 'nested', '-m', 'вложенный', 'release']);
  repo.git(['branch', 'other', root]);
  repo.git(['update-ref', 'refs/remotes/origin/main', root]);
  const feature = repo.text(['rev-parse', 'feature']);
  const before = repo.text(['rev-list', '--reverse', '--topo-order', 'HEAD']).split('\n');
  const plan = makePlan(repo, { ...options, interval: 3, backupBranch: 'rehistory-backup/test' });
  const result = applyPlan(plan);
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  assert.match(result.backupPrefix!, new RegExp(`^refs/rehistory/backups/${uuid}$`));
  assert.match(result.recovery.split(/[\\/]/).at(-1)!, new RegExp(`^rehistory-recovery-${uuid}\\.json$`));
  assert.equal(repo.text(['rev-parse', 'other']), root);
  assert.equal(repo.text(['rev-parse', 'feature']), feature);
  assert.equal(repo.text(['rev-parse', 'origin/main']), root);
  assert.equal(repo.text(['rev-parse', 'rehistory-backup/test']), before.at(-1));
  assert.equal(repo.text(['rev-parse', 'root']), plan.mapping.get(root));
  assert.equal(repo.text(['rev-parse', 'nested^{}']), repo.text(['rev-parse', 'HEAD']));
  assert.equal(repo.text(['rev-parse', `${result.backupPrefix}/tags/release`]), plan.selected.find(r => r.name === 'refs/tags/release')!.oid);
  for (const [index, old] of before.entries()) {
    const next = plan.mapping.get(old)!;
    assert.equal(repo.text(['show', '-s', '--format=%at:%ct:%T:%B', next]), repo.text(['show', '-s', `--format=${options.start + index * 3}:${options.start + index * 3}:%T:%B`, old]));
    const parents = repo.text(['show', '-s', '--format=%P', old]).split(' ').filter(Boolean);
    assert.equal(repo.text(['show', '-s', '--format=%P', next]), parents.map(x => plan.mapping.get(x)).join(' '));
    assert.equal(repo.text(['show', '-s', '--format=%an:%ae:%cn:%ce', next]), repo.text(['show', '-s', '--format=%an:%ae:%cn:%ce', old]));
  }
  repo.git(['fsck', '--strict', '--no-reflogs']);
});

test('dry-run не меняет ни одного файла в .git', t => {
  const repo = fixture(t);
  commit(repo, 'второй');
  const before = snapshot(repo);
  const plan = makePlan(repo, { ...options, backupBranch: 'rehistory-backup/dry' });
  assert.equal(plan.commits, 2);
  assert.deepEqual(snapshot(repo), before);
});

test('смена идентичности всех авторов и коммитеров; отсутствие бекапа', t => {
  const repo = fixture(t);
  const plan = makePlan(repo, { ...options, identity: { name: 'Новый автор', email: 'new@example.org' } });
  const result = applyPlan(plan);
  assert.equal(result.backupPrefix, undefined);
  assert.equal(repo.text(['show', '-s', '--format=%an|%ae|%cn|%ce']), 'Новый автор|new@example.org|Новый автор|new@example.org');
  assert.equal(JSON.parse(readFileSync(result.recovery, 'utf8')).refs[0].new, repo.text(['rev-parse', 'HEAD']));
});

test('теги другой ветки и теги blob остаются без изменений', t => {
  const repo = fixture(t);
  repo.git(['checkout', '-q', '-b', 'other']);
  const other = commit(repo, 'другая');
  repo.git(['tag', '-a', 'other-tag', '-m', 'другая']);
  const tag = repo.text(['rev-parse', 'other-tag']);
  const blob = repo.text(['hash-object', '-w', '--stdin'], 'test');
  repo.git(['tag', 'blob-tag', blob]);
  repo.git(['checkout', '-q', 'main']);
  applyPlan(makePlan(repo, options));
  assert.equal(repo.text(['rev-parse', 'other']), other);
  assert.equal(repo.text(['rev-parse', 'other-tag']), tag);
  assert.equal(repo.text(['rev-parse', 'blob-tag']), blob);
});

test('конкурирующее изменение ветки отменяет применение', t => {
  const repo = fixture(t);
  const plan = makePlan(repo, { ...options, backupBranch: 'rehistory-backup/cas' });
  const changed = commit(repo, 'новый');
  assert.throws(() => applyPlan(plan), /изменился/);
  assert.equal(repo.text(['rev-parse', 'HEAD']), changed);
  assert(!repo.refs().some(r => r.name.includes('rehistory-backup')));
});

test('нельзя перезаписать существующий бекап или частично обновить refs', t => {
  const repo = fixture(t);
  repo.git(['branch', 'rehistory-backup/existing']);
  assert.throws(() => makePlan(repo, { ...options, backupBranch: 'rehistory-backup/existing' }), /уже существует/);
  // The parent ref prevents creation of the nested ref.
  // If prepare fails, all refs must keep their old values.
  const before = repo.refs();
  const plan = makePlan(repo, { ...options, backupBranch: 'rehistory-backup/existing/child' });
  assert.throws(() => applyPlan(plan), /Git update-ref/);
  assert.deepEqual(repo.refs(), before);
});

test('грязное дерево, detached HEAD, stash и незавершённая операция блокируются', t => {
  const repo = fixture(t);
  writeFileSync(join(repo.path, 'untracked'), 'test');
  assert.throws(() => makePlan(repo, options), /чистыми/);
  rmSync(join(repo.path, 'untracked'));
  writeFileSync(join(repo.common, 'MERGE_HEAD'), repo.text(['rev-parse', 'HEAD']));
  assert.throws(() => makePlan(repo, options), /Незавершённая/);
  rmSync(join(repo.common, 'MERGE_HEAD'));
  repo.git(['update-ref', 'refs/stash', repo.text(['rev-parse', 'HEAD'])]);
  assert.throws(() => makePlan(repo, options), /Неподдерживаемые/);
  repo.git(['update-ref', '-d', 'refs/stash']);
  repo.git(['checkout', '-q', '--detach']);
  assert.throws(() => makePlan(repo, options));
});

test('shallow, partial clone, grafts и дополнительные worktree блокируются', t => {
  const repo = fixture(t);
  const oid = repo.text(['rev-parse', 'HEAD']);
  writeFileSync(join(repo.common, 'shallow'), oid + '\n');
  assert.throws(() => makePlan(repo, options), /Shallow/);
  rmSync(join(repo.common, 'shallow'));
  repo.git(['config', 'remote.origin.promisor', 'true']);
  assert.throws(() => makePlan(repo, options), /Partial clone/);
  repo.git(['config', '--unset', 'remote.origin.promisor']);
  mkdirSync(join(repo.common, 'info'), { recursive: true });
  writeFileSync(join(repo.common, 'info', 'grafts'), '');
  assert.throws(() => makePlan(repo, options), /grafts/);
  rmSync(join(repo.common, 'info', 'grafts'));
  repo.git(['worktree', 'add', '-q', '-b', 'linked', join(repo.path, 'linked')]);
  assert.throws(() => makePlan(repo, options), /worktree/);
});

test('удаляются подписи и mergetag, бинарное сообщение сохраняется побайтно', t => {
  const repo = fixture(t);
  const old = repo.git(['cat-file', 'commit', 'HEAD']);
  const split = old.indexOf('\n\n');
  const message = Buffer.from([0xff, 0x00, 0x0a, 0x41]);
  const raw = Buffer.concat([old.subarray(0, split), Buffer.from('\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\nmergetag object fake\n type commit'), Buffer.from('\n\n'), message]);
  const signed = repo.text(['hash-object', '-w', '-t', 'commit', '--stdin'], raw);
  repo.git(['update-ref', 'refs/heads/main', signed]);
  const tagRaw = Buffer.from(`object ${signed}\ntype commit\ntag signed\ntagger Test <test@example.org> 1000000000 +0000\n\nтег\n-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n`);
  const tag = repo.text(['hash-object', '-w', '-t', 'tag', '--stdin'], tagRaw);
  repo.git(['update-ref', 'refs/tags/signed', tag]);
  const plan = makePlan(repo, options);
  assert.equal(plan.stripped, 3);
  applyPlan(plan);
  const rewritten = repo.git(['cat-file', 'commit', 'HEAD']);
  assert.deepEqual(rewritten.subarray(rewritten.indexOf('\n\n') + 2), message);
  assert(!rewritten.includes(Buffer.from('gpgsig')));
  assert(!repo.git(['cat-file', 'tag', 'signed']).includes(Buffer.from('BEGIN PGP')));
});

test('снятие подписи сохраняет произвольные байты сообщения и идемпотентно', () => {
  let seed = 0x51a7;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 256; sample++) {
    // Exclude the marker's first character so each prefix is an unsigned message.
    const bytes = Buffer.from(Array.from({ length: next() % 384 }, () => { const byte = next() & 255; return byte === 45 ? 44 : byte; }));
    const prefix = Buffer.concat([bytes, Buffer.from('\n')]);
    const before = Buffer.from(prefix);
    for (const kind of ['PGP SIGNATURE', 'SSH SIGNATURE']) for (const newline of ['\n', '\r\n']) {
      const armor = Buffer.from(`-----BEGIN ${kind}-----${newline}ZmFrZQ==${newline}-----END ${kind}-----${newline}`);
      const raw = Buffer.concat([prefix, armor]);
      const original = Buffer.from(raw);
      const result = stripTagSignature(raw);
      assert.equal(result.stripped, true, `sample=${sample}; kind=${kind}`);
      assert.deepEqual(result.message, before);
      assert.deepEqual(stripTagSignature(result.message), { message: before, stripped: false });
      assert.deepEqual(raw, original);
    }
  }
});

test('неполная подпись и текст после подписи тега не обрезаются', t => {
  const repo = fixture(t);
  for (const message of [
    'notes\n-----BEGIN PGP SIGNATURE-----\nincomplete example\nkeep this text\n',
    'notes\n-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\nkeep this text\n',
    'notes\n-----BEGIN SSH SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n',
    'notes\n-----BEGIN SIGNED MESSAGE-----\nkeep this text\n',
    'notes\n-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\nkeep this text\n-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n',
    'notes\n-----BEGIN SSH SIGNATURE-----\nfake\n-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n-----END SSH SIGNATURE-----\n',
  ]) {
    const raw = Buffer.from(`object ${repo.text(['rev-parse', 'HEAD'])}\ntype commit\ntag ambiguous\ntagger Test <test@example.org> 1000000000 +0000\n\n${message}`);
    const oid = repo.text(['hash-object', '-w', '-t', 'tag', '--stdin'], raw);
    repo.git(['update-ref', 'refs/tags/ambiguous', oid]);
    const before = snapshot(repo);
    assert.throws(() => makePlan(repo, options), /Неоднозначная подпись тега/);
    assert.deepEqual(snapshot(repo), before);
  }
});

test('не исполняются локальные hooks; блокируется второй процесс', t => {
  const repo = fixture(t);
  const marker = join(repo.path, 'hook-ran');
  mkdirSync(join(repo.common, 'hooks'), { recursive: true });
  const hook = join(repo.common, 'hooks', 'reference-transaction');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const plan = makePlan(repo, options);
  writeFileSync(join(repo.common, 'rehistory.lock'), '');
  assert.throws(() => applyPlan(plan), /EEXIST/);
  rmSync(join(repo.common, 'rehistory.lock'));
  applyPlan(plan);
  assert.throws(() => readFileSync(marker));
});

test('валидация интервалов, дат и идентичности', t => {
  const repo = fixture(t);
  for (const interval of [0, -1, 1.5, NaN, Infinity, 31536001]) assert.throws(() => makePlan(repo, { ...options, interval }));
  assert.throws(() => makePlan(repo, { ...options, start: 253402300800 }));
  for (const name of ['Bad\nName', 'Bad\x1bName', '<bad>', '']) assert.throws(() => validateIdentity(name, 'a@b.c'));
  for (const email of ['bad', 'a@b\nc', 'a@b\x1b', 'a b@c']) assert.throws(() => validateIdentity('Name', email));
  assert.equal(parseDate('2024-02-29T12:00:00+02:00'), Date.parse('2024-02-29T10:00:00Z') / 1000);
  for (const date of ['2023-02-29', '2024-02-30T12:00:00Z', '2024-01-01T25:00:00Z', '2024-01-01T10:00:00', 'yesterday']) assert.throws(() => parseDate(date));
});

test('поддерживается SHA-256 и bare-репозиторий', t => {
  const repo = fixture(t, 'sha256');
  const plan = makePlan(repo, options);
  assert.equal(plan.mapping.values().next().value!.length, 64);
  applyPlan(plan);
  repo.git(['fsck', '--strict']);
  const bare = join(repo.path, 'bare.git');
  repo.git(['-c', 'protocol.file.allow=always', 'clone', '-q', '--bare', '--no-local', repo.path, bare]);
  const bareRepo = new Repository(bare);
  applyPlan(makePlan(bareRepo, { ...options, start: options.start + 1 }));
  bareRepo.git(['fsck', '--strict']);
});


test('файл восстановления возвращает ветку и теги одной транзакцией', t => {
  const repo = fixture(t);
  repo.git(['tag', '-a', 'release', '-m', 'tag']);
  const before = repo.refs();
  const result = applyPlan(makePlan(repo, { ...options, backupBranch: 'my-backup' }));
  const manifest = JSON.parse(readFileSync(result.recovery, 'utf8'));
  const commands = ['start'];
  for (const ref of manifest.refs) commands.push('option no-deref', `update ${ref.name} ${ref.old} ${ref.new}`);
  commands.push('prepare', 'commit', '');
  repo.git(['update-ref', '--stdin'], commands.join('\n'));
  for (const ref of before) assert.equal(repo.text(['rev-parse', ref.name]), ref.oid);
  repo.git(['fsck', '--strict']);
});

test('изоляция окружения Git не зависит от регистра имён переменных', () => {
  const source = { PATH: '/trusted/bin', TERM: 'xterm', GIT_DIR: '/other', git_work_tree: '/other', Git_Config_Count: '1', gIt_cOnFiG_kEy_0: 'core.hooksPath', GITHUB_ACTIONS: 'true' };
  const before = { ...source };
  assert.deepEqual(withoutGitEnvironment(source), { PATH: '/trusted/bin', TERM: 'xterm', GITHUB_ACTIONS: 'true' });
  assert.deepEqual(source, before);
});

test('переменные GIT_* не перенаправляют работу в другой репозиторий', t => {
  const repo = fixture(t);
  const foreign = fixture(t);
  const child = join(repo.common, 'routing-check.mjs');
  writeFileSync(child, `
    import { Repository, makePlan } from ${JSON.stringify(new URL('../dist/src/engine.js', import.meta.url).href)};
    const repo = new Repository(process.argv[2]);
    const plan = makePlan(repo, { start: 1700000000, interval: 1 });
    console.log(JSON.stringify({ commits: plan.commits, common: repo.common }));
  `);
  const before = snapshot(repo);
  const foreignBefore = snapshot(foreign);
  // Use an .mjs file and the fixture directory to avoid npm or eval scope.
  // Do not pass internal Node test context to the child CLI.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const result = spawnSync(process.execPath, [child, repo.path], {
    cwd: repo.path, timeout: 30000,
    // An IDE can set FORCE_COLOR. Machine JSON must not contain ANSI colors.
    env: { ...childEnv, FORCE_COLOR: '1', GIT_DIR: foreign.common, GIT_WORK_TREE: foreign.path, GIT_INDEX_FILE: join(foreign.common, 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/nonexistent' },
  });
  const diagnostic = `Node ${process.version}; status=${result.status}; signal=${result.signal}; error=${result.error?.message || 'нет'}\nstdout: ${result.stdout?.toString()}\nstderr: ${result.stderr?.toString()}`;
  assert.equal(result.status, 0, diagnostic);
  assert.deepEqual(JSON.parse(result.stdout.toString()), { commits: 1, common: repo.common }, diagnostic);
  assert.deepEqual(snapshot(repo), before);
  assert.deepEqual(snapshot(foreign), foreignBefore);
});


test('фиксированное имя бекапа не содержит времени и не перезаписывается', t => {
  const repo = fixture(t);
  assert.equal(defaultBackupBranch, 'rehistory-backup/original');
  repo.git(['branch', defaultBackupBranch]);
  const before = snapshot(repo);
  assert.throws(() => makePlan(repo, { ...options, backupBranch: defaultBackupBranch }), /уже существует/);
  assert.deepEqual(snapshot(repo), before);
});

test('отдельное время первого коммита: минуты, секунды, UTC и смещение', () => {
  assert.equal(parseStart('2026-10-29', '18:45:12+01:00'), Date.parse('2026-10-29T17:45:12Z') / 1000);
  assert.equal(parseStart('2026-10-29', '18:45Z'), Date.parse('2026-10-29T18:45:00Z') / 1000);
  assert.equal(parseStart('2026-10-29', '18:45'), new Date(2026, 9, 29, 18, 45, 0).getTime() / 1000);
  assert.equal(parseStart('2024-02-29', '00:00:00Z'), Date.parse('2024-02-29T00:00:00Z') / 1000);
  for (const time of ['', '24:00', '12:60', '12:00:60', '12:00+24:00', '12:00+01:60', '12:00\nZ', '12:00:00.5Z']) assert.throws(() => parseStart('2026-10-29', time));
  for (const date of ['2026-02-29', '2026-04-31', '1969-12-31', '2026-10-29T12:00:00Z']) assert.throws(() => parseStart(date, '12:00'));
  assert.throws(() => parseStart('9999-12-31', '23:59:59-01:00'));
});

test('введённое время попадает в даты автора и коммитера', t => {
  const repo = fixture(t);
  const start = parseStart('2026-10-29', '18:45:12+01:00');
  applyPlan(makePlan(repo, { ...options, start }));
  assert.equal(repo.text(['show', '-s', '--format=%at:%ct', 'HEAD']), `${start}:${start}`);
});

test('локальное время проверяется при переходах DST; явное смещение однозначно', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rehistory-time-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const child = join(dir, 'time-check.mjs');
  writeFileSync(child, `
    import { parseStart } from ${JSON.stringify(new URL('../dist/src/cli.js', import.meta.url).href)};
    let missing = false;
    try { parseStart('2026-03-29', '02:30'); } catch { missing = true; }
    console.log(JSON.stringify({ missing, delta: parseStart('2026-10-25', '02:30+01:00') - parseStart('2026-10-25', '02:30+02:00') }));
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const result = spawnSync(process.execPath, [child], { env: { ...env, TZ: 'Europe/Amsterdam' }, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), { missing: true, delta: 3600 });
});
