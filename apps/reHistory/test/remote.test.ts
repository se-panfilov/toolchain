import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPlan, makePlan, normalizeCommitMessage, Repository, runGit } from '@reHistory/engine';
import { exportPlan, manifestName, verifyExport } from '@reHistory/export';
import { executePush, networkGit, preparePush, pushRemotes, type PushTransport, remoteCopy, sharedTags, updateTrackingRef, validateRemoteURL } from '@reHistory/remote';
import { test } from 'vitest';

const settings = { flow: 'dates' as const, start: 1700000000, interval: 1 };
type Fixture = {
  root: string;
  repo: Repository;
  server: string;
  url: string;
  before: ReturnType<Repository['refs']>;
  first: string;
  connection: PushTransport;
  git: (args: string[]) => Buffer;
  stats: () => { pushes: number; reads: number; lastArgs: string[] };
};
function fixture(t: { onTestFinished: (fn: () => void) => void }, format = 'sha1'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rehistory-push-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  runGit(root, ['init', '-q', '--template=', '-b', 'main', `--object-format=${format}`, join(root, 'source')]);
  const repo = new Repository(join(root, 'source'));
  repo.git(['config', 'user.name', 'Fixture']);
  repo.git(['config', 'user.email', 'fixture@example.org']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'first']);
  const first = repo.text(['rev-parse', 'HEAD']);
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'side']);
  repo.git(['tag', '-a', 'side-tag', '-m', 'side tag message']);
  repo.git(['checkout', '-q', 'main']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'second']);
  repo.git(['tag', '-a', 'release', '-m', 'tag message']);
  const before = repo.refs();
  const server = join(root, 'server.git');
  repo.git(['init', '-q', '--bare', '--template=', `--object-format=${format}`, server]);
  const url = 'https://example.invalid/project.git';
  repo.git(['remote', 'add', 'origin', url]);
  const git = (args: string[]): Buffer => repo.git(['-c', 'protocol.file.allow=always', ...args]);
  git(['push', '--atomic', server, ...before.map((ref) => `${ref.oid}:${ref.name}`)]);
  let pushes = 0;
  let reads = 0;
  let lastArgs: string[] = [];
  const connection: PushTransport = {
    refs: () => {
      reads++;
      return git(['ls-remote', '--refs', server]).toString().trim();
    },
    push: (_repo, endpoint, args) => {
      pushes++;
      assert.equal(endpoint, url);
      lastArgs = args;
      git(args.map((arg) => (arg === endpoint ? server : arg)));
    }
  };
  return { root, repo, server, url, before, first, connection, git, stats: () => ({ pushes, reads, lastArgs }) };
}

for (const format of ['sha1', 'sha256']) {
  test(`${format}: messages change only in the selected history; export verifies the message`, (t) => {
    const { repo, before, root } = fixture(t, format);
    const plan = makePlan(repo, { flow: 'messages', commitMessage: 'Shared message', backupBranch: 'backup' });
    const target = join(root, 'export.git');
    exportPlan(plan, target);
    assert.equal(verifyExport(target).ok, true);
    const manifest = JSON.parse(readFileSync(join(target, manifestName), 'utf8')) as { policy: Record<string, unknown> };
    manifest.policy.commitMessage = 'Substitute';
    writeFileSync(join(target, manifestName), JSON.stringify(manifest));
    assert(verifyExport(target).errors.some((error) => error.includes('сообщение коммита')));
    applyPlan(plan);
    for (const oid of plan.commitOrder) assert.equal(repo.text(['show', '-s', '--format=%B', oid]), 'Shared message');
    assert.equal(repo.text(['show', '-s', '--format=%B', 'side']), 'side');
    assert.equal(repo.text(['for-each-ref', '--format=%(contents)', 'refs/tags/release']), 'tag message');
    for (const ref of before.filter((ref) => ref.name.includes('side'))) assert.equal(repo.text(['rev-parse', ref.name]), ref.oid);
  });

  test(`${format}: atomic push changes only the selected branch and its tags`, (t) => {
    const { repo, before, server, connection, stats, git, root } = fixture(t, format);
    const marker = join(root, 'hook-ran');
    mkdirSync(join(repo.common, 'hooks'));
    writeFileSync(join(repo.common, 'hooks/pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    for (const [key, value] of [
      ['remote.origin.mirror', 'true'],
      ['push.followTags', 'true'],
      ['push.gpgSign', 'true'],
      ['push.recurseSubmodules', 'on-demand'],
      ['push.pushOption', 'unexpected']
    ] as const)
      repo.git(['config', key, value]);
    const plan = makePlan(repo, { flow: 'messages', backupBranch: 'backup', commitMessage: 'Uniform' });
    applyPlan(plan);
    executePush(preparePush(plan, 'origin', connection), connection);
    assert.equal(stats().pushes, 1);
    assert(stats().lastArgs.includes('--atomic'));
    assert.equal(stats().lastArgs.filter((arg) => arg.startsWith('--force-with-lease=')).length, plan.selected.length);
    assert(!stats().lastArgs.some((arg) => ['--force', '--all', '--tags', '--mirror'].includes(arg)));
    const actual = new Map(
      git(['ls-remote', '--refs', server])
        .toString()
        .trim()
        .split('\n')
        .map((line) => {
          const [oid, name] = line.split('\t');
          return [name, oid];
        })
    );
    assert.equal(actual.size, before.length);
    for (const ref of before) assert.equal(actual.get(ref.name), plan.selected.some((item) => item.name === ref.name) ? plan.mapping.get(ref.oid) : ref.oid);
    assert.equal(existsSync(marker), false);
  });
}

test('after push the remote-tracking branch is updated and the next flow is not blocked', (t) => {
  const { repo, connection, before } = fixture(t);
  const main = before.find((ref) => ref.name === 'refs/heads/main')!.oid;
  repo.git(['update-ref', 'refs/remotes/origin/main', main]);
  assert.equal(remoteCopy(repo, main).unpushed, 0);
  const plan = makePlan(repo, { flow: 'messages', commitMessage: 'New' });
  applyPlan(plan);
  const head = plan.mapping.get(main)!;
  assert.equal(remoteCopy(repo, head).unpushed, 2);
  const push = preparePush(plan, 'origin', connection);
  executePush(push, connection);
  assert.equal(updateTrackingRef(push), 'refs/remotes/origin/main');
  assert.equal(repo.text(['rev-parse', 'refs/remotes/origin/main']), head);
  assert.equal(remoteCopy(repo, head).unpushed, 0);
});

test('remote-tracking branch stays unchanged with a nonstandard fetch refspec', (t) => {
  const { repo, connection, before } = fixture(t);
  const main = before.find((ref) => ref.name === 'refs/heads/main')!.oid;
  repo.git(['update-ref', 'refs/remotes/origin/main', main]);
  repo.git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/mirror/main']);
  const plan = makePlan(repo, { flow: 'authors', identity: { name: 'New', email: 'new@example.org' } });
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  executePush(push, connection);
  assert.equal(updateTrackingRef(push), undefined);
  assert.equal(repo.text(['rev-parse', 'refs/remotes/origin/main']), main);
});

test('message validation rejects empty text, hidden characters, and values that are too large', () => {
  for (const value of ['', ' \n\t ', 'x\x1b[31m', 'x\0', 'x\r', 'x\u202e', 'é'.repeat(32769)]) assert.throws(() => normalizeCommitMessage(value), /Сообщение/);
  assert.equal(normalizeCommitMessage('Grüße').toString(), 'Grüße\n');
  assert.equal(normalizeCommitMessage('first\nsecond\n').toString(), 'first\nsecond\n');
});

test('leases protect against a server race; tag and branch updates are not applied partially', (t) => {
  const { repo, connection, git, server, before } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  const side = before.find((ref) => ref.name === 'refs/heads/side')!.oid;
  git(['--git-dir', server, 'update-ref', 'refs/heads/main', side]);
  assert.throws(() => executePush(push, connection), /Git/);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'refs/heads/main']).toString().trim(), side);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'refs/tags/release']).toString().trim(), before.find((ref) => ref.name === 'refs/tags/release')!.oid);
});

test('a changed server and disabled atomic push stop the push without fallback', (t) => {
  const { repo, connection, git, server, before, stats } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const side = before.find((ref) => ref.name === 'refs/heads/side')!.oid;
  git(['--git-dir', server, 'update-ref', 'refs/heads/main', side]);
  assert.throws(() => preparePush(plan, 'origin', connection), /неизвестные изменения/);
  assert.equal(stats().pushes, 0);
  git(['--git-dir', server, 'update-ref', 'refs/heads/main', plan.headOid]);
  const push = preparePush(plan, 'origin', connection);
  git(['--git-dir', server, 'config', 'receive.advertiseAtomic', 'false']);
  assert.throws(() => executePush(push, connection), /Git/);
  assert.equal(stats().pushes, 1);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'main']).toString().trim(), plan.headOid);
});

test('a local race and a config change after the check prevent the push', (t) => {
  const { repo, connection, stats } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  repo.git(['config', 'push.default', 'matching']);
  assert.throws(() => executePush(push, connection), /Настройки Git изменились/);
  repo.git(['config', '--unset', 'push.default']);
  repo.git(['update-ref', 'refs/tags/release', plan.headOid]);
  assert.throws(() => executePush(push, connection), /Локальная ветка или тег изменились/);
  assert.equal(stats().pushes, 0);
});

test('upstream selects the destination branch; a known old ancestor is accepted', (t) => {
  const { repo, connection, git, server, first } = fixture(t);
  repo.git(['config', 'branch.main.remote', 'origin']);
  repo.git(['config', 'branch.main.merge', 'refs/heads/trunk']);
  git(['--git-dir', server, 'update-ref', 'refs/heads/trunk', first]);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  assert.deepEqual(pushRemotes(repo, plan.head), { names: ['origin'], initial: 0 });
  const push = preparePush(plan, 'origin', connection);
  assert.equal(push.refs.find((ref) => ref.local === plan.head)?.destination, 'refs/heads/trunk');
  executePush(push, connection);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'trunk']).toString().trim(), plan.mapping.get(plan.headOid));
  assert.equal(git(['--git-dir', server, 'rev-parse', 'main']).toString().trim(), plan.headOid);
});

test('dangerous, ambiguous, and substituted URLs are rejected before a network request', (t) => {
  const { repo, connection, stats } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  for (const url of [
    'file:///tmp/repo',
    'ext::sh',
    'http://host/repo',
    'https://u:p@host/repo',
    'https://token@host/repo',
    'https://host/repo?token=x',
    'ssh://host/repo\nother',
    'https://host/a/../repo',
    'https://host/a/%2e%2e/repo',
    'https://host/a\\repo'
  ])
    assert.throws(() => validateRemoteURL(url));
  assert.equal(validateRemoteURL('git@host:owner/repo.git'), 'git@host:owner/repo.git');
  repo.git(['config', 'url.https://other.invalid/.pushInsteadOf', 'https://example.invalid/']);
  assert.throws(() => preparePush(plan, 'origin', connection), /URL-подстановки/);
  repo.git(['config', '--remove-section', 'url.https://other.invalid/']);
  repo.git(['config', '--add', 'remote.origin.pushurl', 'https://host/one']);
  repo.git(['config', '--add', 'remote.origin.pushurl', 'https://host/two']);
  assert.throws(() => preparePush(plan, 'origin', connection), /одним URL/);
  assert.equal(stats().reads, 0);
});

test('invalid and repeated server lines prevent the push', (t) => {
  const { repo, connection, stats } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  for (const advertisement of ['not a ref', `${plan.headOid}\trefs/heads/main\n${plan.headOid}\trefs/heads/main`, `${'a'.repeat(64)}\trefs/heads/main`]) {
    assert.throws(() => preparePush(plan, 'origin', { ...connection, refs: () => advertisement }), /Некорректный ответ сервера/);
  }
  assert.equal(stats().pushes, 0);
});

test('new UTF-8 text does not inherit the old message encoding', (t) => {
  const { repo } = fixture(t);
  const original = repo.git(['cat-file', 'commit', 'HEAD']);
  const split = original.indexOf(Buffer.from('\n\n'));
  const encoded = Buffer.concat([original.subarray(0, split), Buffer.from('\nencoding ISO-8859-1\n\nold\n')]);
  const oid = repo.text(['hash-object', '-w', '-t', 'commit', '--stdin'], encoded);
  repo.git(['update-ref', 'HEAD', oid]);
  const plan = makePlan(repo, { flow: 'messages', commitMessage: 'Shared message: café ✓' });
  applyPlan(plan);
  assert.equal(repo.text(['show', '-s', '--format=%B', 'HEAD']), 'Shared message: café ✓');
  assert(!repo.git(['cat-file', 'commit', 'HEAD']).includes(Buffer.from('\nencoding ')));
});

test('a tag race cannot partially update the branch; an unknown tag is rejected before push', (t) => {
  const { repo, connection, git, server, before } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  const side = before.find((ref) => ref.name === 'refs/heads/side')!.oid;
  git(['--git-dir', server, 'update-ref', 'refs/tags/release', side]);
  assert.throws(() => preparePush(plan, 'origin', connection), /неизвестные изменения/);
  assert.throws(() => executePush(push, connection), /Git/);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'main']).toString().trim(), plan.headOid);
});

test('an empty server uses empty leases and receives only the selected history', (t) => {
  const { repo, connection, git, server, before } = fixture(t);
  for (const ref of before) git(['--git-dir', server, 'update-ref', '-d', ref.name]);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  assert(push.refs.every((ref) => ref.expected === ''));
  assert.deepEqual(
    push.optional.map((ref) => [ref.destination, ref.reasons]),
    [['refs/tags/release', ['new']]]
  );
  executePush(push, connection, true);
  const names = git(['--git-dir', server, 'for-each-ref', '--format=%(refname)']).toString().trim().split('\n');
  assert.deepEqual(names.sort(), plan.selected.map((ref) => ref.name).sort());
});

test('new local tags are not sent without a separate choice', (t) => {
  const { repo, connection, git, server, stats } = fixture(t);
  repo.git(['tag', 'local-only']);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  assert.deepEqual(
    push.optional.map((ref) => [ref.destination, ref.reasons]),
    [['refs/tags/local-only', ['new']]]
  );
  executePush(push, connection);
  assert(!stats().lastArgs.some((arg) => arg.includes('local-only')));
  assert.equal(git(['--git-dir', server, 'for-each-ref', 'refs/tags/local-only']).toString(), '');
  assert.equal(git(['--git-dir', server, 'rev-parse', 'refs/tags/release^{}']).toString().trim(), repo.text(['rev-parse', 'refs/tags/release^{}']));
});

test('tags of other branches move on the server only after a separate choice', (t) => {
  const { repo, connection, git, server } = fixture(t);
  repo.git(['checkout', '-q', '-b', 'feature']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'feature']);
  git(['push', server, 'feature']);
  const release = git(['--git-dir', server, 'rev-parse', 'refs/tags/release']).toString().trim();
  const plan = makePlan(repo, { ...settings, backupBranch: 'backup' });
  applyPlan(plan);
  assert.deepEqual(sharedTags(plan), new Set(['refs/tags/release']));
  const push = preparePush(plan, 'origin', connection);
  assert.deepEqual(
    push.refs.map((ref) => ref.destination),
    ['refs/heads/feature']
  );
  assert.deepEqual(
    push.optional.map((ref) => [ref.destination, ref.reasons]),
    [['refs/tags/release', ['shared']]]
  );
  executePush(push, connection);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'refs/tags/release']).toString().trim(), release);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'feature']).toString().trim(), plan.mapping.get(plan.headOid));
  // The release tag stays in the history of main on the server.
  git(['--git-dir', server, 'merge-base', '--is-ancestor', 'refs/tags/release^{}', 'main']);
  executePush(preparePush(plan, 'origin', connection), connection, true);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'refs/tags/release']).toString().trim(), plan.mapping.get(plan.selected.find((ref) => ref.name === 'refs/tags/release')!.oid));
});

test('a single-branch clone keeps server tags of other branches for a separate choice', (t) => {
  const { repo, connection, git, server } = fixture(t);
  repo.git(['checkout', '-q', '-b', 'feature']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'feature']);
  git(['push', server, 'feature']);
  repo.git(['update-ref', 'refs/remotes/origin/feature', 'feature']);
  // A single-branch clone has no local copy of other branches. A new commit on the server main is unknown locally.
  repo.git(['branch', '-D', 'main', 'side']);
  const unknown = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', '--git-dir', server, 'commit-tree', '-p', 'main', '-m', 'server only', 'main^{tree}']).toString().trim();
  git(['--git-dir', server, 'update-ref', 'refs/heads/main', unknown]);
  const release = git(['--git-dir', server, 'rev-parse', 'refs/tags/release']).toString().trim();
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  assert.deepEqual(sharedTags(plan), new Set());
  const push = preparePush(plan, 'origin', connection);
  assert.deepEqual(
    push.refs.map((ref) => ref.destination),
    ['refs/heads/feature']
  );
  assert.deepEqual(
    push.optional.map((ref) => [ref.destination, ref.reasons]),
    [['refs/tags/release', ['unverified']]]
  );
  executePush(push, connection);
  assert.equal(git(['--git-dir', server, 'rev-parse', 'refs/tags/release']).toString().trim(), release);
  git(['--git-dir', server, 'merge-base', '--is-ancestor', 'refs/tags/release^{}', 'main']);
});

test('server branches that exist only as local objects still mark shared tags', (t) => {
  const { repo, connection, git, server } = fixture(t);
  repo.git(['checkout', '-q', '-b', 'feature']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'feature']);
  git(['push', server, 'feature']);
  repo.git(['update-ref', 'refs/remotes/origin/feature', 'feature']);
  // The objects of main and side stay in the local repository without local refs.
  repo.git(['branch', '-D', 'main', 'side']);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  assert.deepEqual(sharedTags(plan), new Set());
  const push = preparePush(plan, 'origin', connection);
  assert.deepEqual(
    push.optional.map((ref) => [ref.destination, ref.reasons]),
    [['refs/tags/release', ['shared']]]
  );
});

test('the network adapter disables helpers, askpass, redirects, and custom SSH commands', () => {
  let observed: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const repo = {
    git: (args: string[], _input: unknown, env: NodeJS.ProcessEnv) => {
      observed = { args, env };
      return Buffer.from('ok');
    }
  } as unknown as Repository;
  assert.equal(networkGit(repo, ['ls-remote', '--refs', 'https://host/repo']).toString(), 'ok');
  assert(observed);
  for (const option of ['http.sslVerify=true', 'http.followRedirects=false', 'credential.helper=', 'core.askPass=']) assert(observed.args.includes(option));
  assert.equal(observed.env.GIT_ASKPASS, '');
  assert.equal(observed.env.SSH_ASKPASS, '');
  assert.match(observed.env.GIT_SSH_COMMAND!, /^ssh -oBatchMode=yes -oConnectTimeout=15 /);
});
