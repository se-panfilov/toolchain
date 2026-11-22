import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { optionsFromArguments, parseArguments } from '@reHistory/cli';
import { applyPlan, makePlan, Repository, runGit } from '@reHistory/engine';
import { exportPlan } from '@reHistory/export';
import { periodStart } from '@reHistory/period';
import { preparePush, type PushTransport, sharedTags } from '@reHistory/remote';
import { test } from 'vitest';

type Context = { onTestFinished: (fn: () => void) => void };
function temp(t: Context): string {
  const path = mkdtempSync(join(tmpdir(), 'rehistory-period-'));
  t.onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function init(t: Context): Repository {
  const root = temp(t);
  runGit(root, ['init', '-q', '--template=', '--initial-branch=main', join(root, 'source')]);
  const repo = new Repository(join(root, 'source'));
  repo.git(['config', 'user.name', 'Old Author']);
  repo.git(['config', 'user.email', 'old@example.org']);
  return repo;
}
function commit(repo: Repository, message: string, time: number): string {
  repo.git(['commit', '-q', '--allow-empty', '-m', message], undefined, { GIT_AUTHOR_DATE: `${time} +0200`, GIT_COMMITTER_DATE: `${time} +0200` });
  return repo.text(['rev-parse', 'HEAD']);
}
function tag(repo: Repository, name: string, time: number): string {
  repo.git(['tag', '-a', '-m', name, name], undefined, { GIT_COMMITTER_DATE: `${time} +0100` });
  return repo.text(['rev-parse', `refs/tags/${name}`]);
}
function raw(repo: Repository, oid: string): string {
  return repo.text(['cat-file', '-p', oid]);
}
const since = 1650000000;
/** Two old commits with a tag, then two commits inside the period with a tag. */
function history(t: Context): { repo: Repository; old: string[]; oldTag: string } {
  const repo = init(t);
  const old = [commit(repo, 'old one', 1600000000), commit(repo, 'old two', 1600000100)];
  const oldTag = tag(repo, 'v1', 1600000200);
  commit(repo, 'new one', 1700000000);
  commit(repo, 'new two', 1700000100);
  tag(repo, 'v2', 1700000200);
  return { repo, old, oldTag };
}
const identity = { name: 'New Author', email: 'new@example.org' };

test('day and week are fixed durations; month and year clamp the day of the month', () => {
  const now = new Date(2024, 2, 31, 15, 30, 10);
  const seconds = Math.floor(now.getTime() / 1000);
  assert.equal(periodStart('day', now), seconds - 86400);
  assert.equal(periodStart('week', now), seconds - 7 * 86400);
  assert.equal(periodStart('month', now), Math.floor(new Date(2024, 1, 29, 15, 30, 10).getTime() / 1000));
  assert.equal(periodStart('month', new Date(2023, 2, 31, 8, 0, 0)), Math.floor(new Date(2023, 1, 28, 8, 0, 0).getTime() / 1000));
  assert.equal(periodStart('month', new Date(2024, 0, 15, 0, 0, 0)), Math.floor(new Date(2023, 11, 15, 0, 0, 0).getTime() / 1000));
  assert.equal(periodStart('year', new Date(2024, 1, 29, 12, 0, 0)), Math.floor(new Date(2023, 1, 28, 12, 0, 0).getTime() / 1000));
  assert.equal(periodStart('year', now), Math.floor(new Date(2023, 2, 31, 15, 30, 10).getTime() / 1000));
  assert.throws(() => periodStart('day', new Date(Number.NaN)));
  assert.throws(() => periodStart('day', new Date(3600 * 1000)));
});

test('a period keeps older commits and their tags unchanged', (t) => {
  for (const options of [
    { flow: 'dates' as const, start: 1800000000, interval: 10 },
    { flow: 'authors' as const, identity, tagIdentity: identity },
    { flow: 'messages' as const, commitMessage: 'Replaced' }
  ]) {
    const { repo, old, oldTag } = history(t);
    const plan = makePlan(repo, { ...options, since });
    assert.equal(plan.commits, 2);
    assert.equal(plan.reparented, 0);
    for (const oid of [...old, oldTag]) assert.equal(plan.mapping.get(oid), oid);
    applyPlan(plan);
    assert.equal(repo.text(['rev-parse', 'HEAD~2']), old[1]);
    assert.equal(repo.text(['rev-parse', 'refs/tags/v1']), oldTag);
    const log = repo.text(['log', '--format=%an|%cd|%s', '--date=raw', '-2']).split('\n').reverse();
    if (options.flow === 'dates') assert.deepEqual(log, ['Old Author|1800000000 +0000|new one', 'Old Author|1800000010 +0000|new two']);
    if (options.flow === 'authors') assert.deepEqual(log, ['New Author|1700000000 +0200|new one', 'New Author|1700000100 +0200|new two']);
    if (options.flow === 'messages') assert.deepEqual(log, ['Old Author|1700000000 +0200|Replaced', 'Old Author|1700000100 +0200|Replaced']);
    const tagger = /^tagger (.*)$/m.exec(raw(repo, repo.text(['rev-parse', 'refs/tags/v2'])))?.[1];
    if (options.flow === 'dates') assert.equal(tagger, 'Old Author <old@example.org> 1800000010 +0000');
    if (options.flow === 'authors') assert.equal(tagger, 'New Author <new@example.org> 1700000200 +0100');
    if (options.flow === 'messages') assert.equal(tagger, 'Old Author <old@example.org> 1700000200 +0100');
  }
});

test('a commit after the period start with an older date keeps its metadata and gets a new parent', (t) => {
  const repo = init(t);
  commit(repo, 'old', 1600000000);
  commit(repo, 'recent', 1700000000);
  const late = commit(repo, 'late with old date', 1600000500);
  tag(repo, 'late', 1600000600);
  const before = raw(repo, late).replace(/^parent .*\n/m, '');
  const lateTag = raw(repo, repo.text(['rev-parse', 'refs/tags/late'])).replace(/^object .*\n/m, '');
  const plan = makePlan(repo, { flow: 'authors', identity, tagIdentity: identity, since });
  assert.equal(plan.commits, 1);
  assert.equal(plan.reparented, 1);
  applyPlan(plan);
  assert.notEqual(repo.text(['rev-parse', 'HEAD']), late);
  assert.equal(raw(repo, repo.text(['rev-parse', 'HEAD'])).replace(/^parent .*\n/m, ''), before);
  assert.equal(repo.text(['rev-parse', 'HEAD~1^{commit}']), repo.text(['rev-parse', 'HEAD~1']));
  assert.match(raw(repo, 'HEAD~1'), /^author New Author <new@example.org> 1700000000 \+0200$/m);
  // The tag moves to the new object of its commit, but keeps the tagger of the old one.
  assert.equal(raw(repo, repo.text(['rev-parse', 'refs/tags/late'])).replace(/^object .*\n/m, ''), lateTag);
});

test('the dates flow counts steps only for commits of the period', (t) => {
  const repo = init(t);
  commit(repo, 'old', 1600000000);
  commit(repo, 'a', 1700000000);
  commit(repo, 'b', 1700000001);
  commit(repo, 'c', 1700000002);
  applyPlan(makePlan(repo, { flow: 'dates', start: 1710000000, interval: 60, since }));
  assert.deepEqual(repo.text(['log', '--format=%ct', '-4']).split('\n').reverse(), ['1600000000', '1710000000', '1710000060', '1710000120']);
});

test('a period without commits gives a plan without objects', (t) => {
  const { repo } = history(t);
  const plan = makePlan(repo, { flow: 'messages', commitMessage: 'x', since: 1800000000 });
  assert.equal(plan.commits, 0);
  assert.equal(plan.objects.length, 0);
  assert.ok(plan.selected.every((ref) => plan.mapping.get(ref.oid) === ref.oid));
});

test('a signature outside the period stays; a signature inside the period is counted for removal', (t) => {
  const repo = init(t);
  commit(repo, 'old', 1600000000);
  const signed = Buffer.from(raw(repo, 'HEAD').replace(/\n\n/, '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n') + '\n');
  const oid = repo.text(['hash-object', '-w', '-t', 'commit', '--stdin'], signed);
  repo.git(['update-ref', 'refs/heads/main', oid]);
  repo.git(['reset', '-q', '--hard']);
  commit(repo, 'new', 1700000000);
  const outside = makePlan(repo, { flow: 'messages', commitMessage: 'x', since });
  assert.equal(outside.stripped, 0);
  assert.equal(outside.mapping.get(oid), oid);
  assert.equal(makePlan(repo, { flow: 'messages', commitMessage: 'x', since: 1500000000 }).stripped, 1);
});

test('an export rejects a period', (t) => {
  const { repo } = history(t);
  const plan = makePlan(repo, { flow: 'messages', commitMessage: 'x', since });
  assert.throws(() => exportPlan(plan, join(temp(t), 'export.git')), /Период/);
});

test('a push and the shared-tag check skip tags that the period does not change', (t) => {
  const { repo, oldTag } = history(t);
  repo.git(['remote', 'add', 'origin', 'https://example.org/owner/repo.git']);
  const head = repo.text(['rev-parse', 'HEAD']);
  const v2 = repo.text(['rev-parse', 'refs/tags/v2']);
  // v1 is also in another branch. It is outside the period, so it is not shared for this rewrite.
  repo.git(['branch', 'other', 'v1']);
  repo.git(['update-ref', 'refs/remotes/origin/main', head]);
  const plan = makePlan(repo, { flow: 'messages', commitMessage: 'x', since });
  applyPlan(plan);
  assert.equal(sharedTags(plan).size, 0);
  const pushes: string[][] = [];
  const connection: PushTransport = {
    refs: () => [`${head}\trefs/heads/main`, `${oldTag}\trefs/tags/v1`, `${v2}\trefs/tags/v2`].join('\n'),
    push: (_repo, _url, args) => {
      pushes.push(args);
    }
  };
  const push = preparePush(plan, 'origin', connection);
  assert.deepEqual(
    push.refs.map((ref) => ref.destination),
    ['refs/heads/main', 'refs/tags/v2']
  );
  assert.equal(push.optional.length, 0);
});

test('command-line arguments for an unattended run are complete and belong to one flow', () => {
  const valid = parseArguments(['--flow', 'authors', '--day', '--name', 'A', '--email', 'a@example.org', '--no-backup', '--force-push']);
  assert.equal(valid.period, 'day');
  assert.equal(valid.forcePush, true);
  assert.deepEqual(optionsFromArguments(valid), { flow: 'authors', identity: { name: 'A', email: 'a@example.org' }, tagIdentity: { name: 'A', email: 'a@example.org' } });
  assert.deepEqual(
    optionsFromArguments(parseArguments(['--flow', 'dates', '--week', '--date', '2024-01-02', '--time', '10:00:00Z', '--interval', '5', '--tag-dates', 'preserve', '--backup-branch', 'b'])),
    {
      flow: 'dates',
      start: 1704189600,
      interval: 5,
      tagPolicy: 'preserve'
    }
  );
  assert.equal(parseArguments(['--month']).period, 'month');
  assert.equal(parseArguments(['--year', '--force-push', '--remote', 'origin']).pushRemote, 'origin');
  for (const args of [
    ['--day', '--week'],
    ['--day', '--day'],
    ['--flow', 'all', '--day', '--no-backup'],
    ['--flow', 'messages', '--message', 'x', '--no-backup'],
    ['--flow', 'messages', '--day', '--message', 'x'],
    ['--flow', 'messages', '--day', '--message', 'x', '--no-backup', '--backup-branch', 'b'],
    ['--flow', 'messages', '--day', '--no-backup'],
    ['--flow', 'messages', '--day', '--message', 'x', '--name', 'A', '--no-backup'],
    ['--flow', 'authors', '--day', '--name', 'A', '--no-backup'],
    ['--flow', 'dates', '--day', '--tag-dates', 'other', '--no-backup'],
    ['--message', 'x'],
    ['--strip-signatures'],
    ['--no-backup'],
    ['--remote', 'origin'],
    ['--force-push', '--dry-run'],
    ['--day', '--export', '/tmp/x'],
    ['--force-push', '--audit'],
    ['--flow', 'messages', '--day', '--message', '--force-push', '--no-backup']
  ])
    assert.throws(() => parseArguments(args), Error, JSON.stringify(args));
  for (const args of [
    ['--flow', 'dates', '--day', '--interval', '0', '--no-backup'],
    ['--flow', 'dates', '--day', '--date', '2024-02-30', '--no-backup'],
    ['--flow', 'authors', '--day', '--name', '<x>', '--email', 'a@example.org', '--no-backup'],
    ['--flow', 'messages', '--day', '--message', '\u001b[31m', '--no-backup']
  ])
    assert.throws(() => optionsFromArguments(parseArguments(args)), Error, JSON.stringify(args));
});

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
function run(repo: Repository, args: string[]): { status: number | null; output: string } {
  // spawnSync has no TTY. An unattended run must not need one.
  const result = spawnSync(process.execPath, [cli, '--repo', repo.path, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 30000 });
  return { status: result.status, output: result.stdout + result.stderr };
}
function recent(t: Context): { repo: Repository; old: string } {
  const repo = init(t);
  const old = commit(repo, 'old', 1600000000);
  const now = Math.floor(Date.now() / 1000);
  commit(repo, 'today one', now - 3600);
  commit(repo, 'today two', now - 60);
  return { repo, old };
}
const messages = ['--flow', 'messages', '--day', '--message', 'Scheduled'];

test.skipIf(process.platform === 'win32')('an unattended run changes only commits of the period, without a TTY', (t) => {
  const { repo, old } = recent(t);
  repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD'])]);
  const dry = run(repo, [...messages, '--no-backup', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.equal(repo.text(['log', '-1', '--format=%s']), 'today two');
  const result = run(repo, [...messages, '--backup-branch', 'backup/scheduled']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /--force-push не указан/);
  assert.deepEqual(repo.text(['log', '--format=%s']).split('\n'), ['Scheduled', 'Scheduled', 'old']);
  assert.equal(repo.text(['rev-parse', 'HEAD~2']), old);
  assert.equal(repo.text(['rev-parse', 'backup/scheduled']), repo.text(['rev-parse', 'refs/remotes/origin/main']));
  // The next run of the same schedule stops before any write: the backup name exists and the rewrite is not pushed.
  const again = run(repo, [...messages, '--backup-branch', 'backup/scheduled']);
  assert.equal(again.status, 1);
  const unchanged = run(repo, ['--flow', 'messages', '--day', '--message', 'Scheduled', '--no-backup']);
  assert.equal(unchanged.status, 1);
  assert.match(unchanged.output, /Незапушенные коммиты/);
});

test.skipIf(process.platform === 'win32')('an unattended run never assumes consent', (t) => {
  const { repo } = recent(t);
  const head = repo.text(['rev-parse', 'HEAD']);
  const noCopy = run(repo, [...messages, '--no-backup']);
  assert.equal(noCopy.status, 1);
  assert.match(noCopy.output, /Без копии на сервере/);
  const interactive = run(repo, ['--day']);
  assert.equal(interactive.status, 1);
  assert.match(interactive.output, /--flow/);
  repo.git(['update-ref', 'refs/remotes/origin/main', head]);
  // A signed commit in the period needs an explicit flag.
  const signed = Buffer.from(raw(repo, 'HEAD').replace(/\n\n/, '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n') + '\n');
  const signedOid = repo.text(['hash-object', '-w', '-t', 'commit', '--stdin'], signed);
  repo.git(['update-ref', 'refs/heads/main', signedOid]);
  repo.git(['update-ref', 'refs/remotes/origin/main', signedOid]);
  const refused = run(repo, [...messages, '--no-backup']);
  assert.equal(refused.status, 1);
  assert.match(refused.output, /--strip-signatures/);
  assert.equal(repo.text(['rev-parse', 'HEAD']), signedOid);
  const allowed = run(repo, [...messages, '--no-backup', '--strip-signatures']);
  assert.equal(allowed.status, 0, allowed.output);
  assert.doesNotMatch(raw(repo, 'HEAD'), /gpgsig/);
});

test.skipIf(process.platform === 'win32')('--force-push stops without a clear remote and reports the local rewrite', (t) => {
  const { repo } = recent(t);
  repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD'])]);
  const missing = run(repo, [...messages, '--no-backup', '--force-push']);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /Remote не настроен/);
  assert.equal(repo.text(['log', '-1', '--format=%s']), 'today two');

  const second = recent(t).repo;
  second.git(['remote', 'add', 'first', 'https://example.org/owner/first.git']);
  second.git(['remote', 'add', 'second', 'https://example.org/owner/second.git']);
  second.git(['update-ref', 'refs/remotes/first/main', second.text(['rev-parse', 'HEAD'])]);
  const ambiguous = run(second, [...messages, '--no-backup', '--force-push']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.output, /--remote NAME/);
  const unsafe = run(second, [...messages, '--no-backup', '--force-push', '--remote', 'missing']);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.output, /Remote не найден: missing/);
  second.git(['remote', 'set-url', 'first', '/tmp/local.git']);
  const local = run(second, [...messages, '--no-backup', '--force-push', '--remote', 'first']);
  assert.equal(local.status, 1);
  assert.match(local.output, /HTTPS\/SSH/);
  // Every check above runs before the rewrite.
  assert.equal(second.text(['log', '-1', '--format=%s']), 'today two');
});
