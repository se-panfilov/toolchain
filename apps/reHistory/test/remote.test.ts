import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync,rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPlan, makePlan, normalizeCommitMessage,Repository, runGit } from '@reHistory/engine';
import { exportPlan, manifestName,verifyExport } from '@reHistory/export';
import { executePush, networkGit, preparePush, pushRemotes, type PushTransport,validateRemoteURL } from '@reHistory/remote';
import { test } from 'vitest';

const settings = { start: 1700000000, interval: 1 };
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
  test(`${format}: сообщения заменяются только в выбранной истории; экспорт проверяет сообщение`, (t) => {
    const { repo, before, root } = fixture(t, format);
    const plan = makePlan(repo, { ...settings, commitMessage: 'Общее сообщение', backupBranch: 'backup' });
    const target = join(root, 'export.git');
    exportPlan(plan, target);
    assert.equal(verifyExport(target).ok, true);
    const manifest = JSON.parse(readFileSync(join(target, manifestName), 'utf8'));
    manifest.policy.commitMessage = 'Подмена';
    writeFileSync(join(target, manifestName), JSON.stringify(manifest));
    assert(verifyExport(target).errors.some((error) => error.includes('сообщение коммита')));
    applyPlan(plan);
    for (const oid of plan.commitOrder) assert.equal(repo.text(['show', '-s', '--format=%B', oid]), 'Общее сообщение');
    assert.equal(repo.text(['show', '-s', '--format=%B', 'side']), 'side');
    assert.equal(repo.text(['for-each-ref', '--format=%(contents)', 'refs/tags/release']), 'tag message');
    for (const ref of before.filter((ref) => ref.name.includes('side'))) assert.equal(repo.text(['rev-parse', ref.name]), ref.oid);
  });

  test(`${format}: атомарный push меняет только выбранную ветку и её теги`, (t) => {
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
    ])
      repo.git(['config', key, value]);
    const plan = makePlan(repo, { ...settings, backupBranch: 'backup', commitMessage: 'Uniform' });
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

test('проверка сообщения отклоняет пустой текст, скрытые символы и слишком большие значения', () => {
  for (const value of ['', ' \n\t ', 'x\x1b[31m', 'x\0', 'x\r', 'x\u202e', 'я'.repeat(32769)]) assert.throws(() => normalizeCommitMessage(value), /Сообщение/);
  assert.equal(normalizeCommitMessage('Привет').toString(), 'Привет\n');
  assert.equal(normalizeCommitMessage('first\nsecond\n').toString(), 'first\nsecond\n');
});

test('lease защищает от гонки сервера; обновления тегов и ветки не применяются частично', (t) => {
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

test('изменённый сервер и отключённый atomic останавливают push без fallback', (t) => {
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

test('локальная гонка и смена config после проверки не допускают отправку', (t) => {
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

test('upstream выбирает ветку назначения; известный старый предок допустим', (t) => {
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

test('опасные, неоднозначные и подменённые URL отклоняются до сетевого запроса', (t) => {
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

test('неверные и повторные строки сервера не допускают отправку', (t) => {
  const { repo, connection, stats } = fixture(t);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  for (const advertisement of ['not a ref', `${plan.headOid}\trefs/heads/main\n${plan.headOid}\trefs/heads/main`, `${'a'.repeat(64)}\trefs/heads/main`]) {
    assert.throws(() => preparePush(plan, 'origin', { ...connection, refs: () => advertisement }), /Некорректный ответ сервера/);
  }
  assert.equal(stats().pushes, 0);
});

test('новый UTF-8 текст не наследует старую кодировку сообщения', (t) => {
  const { repo } = fixture(t);
  const original = repo.git(['cat-file', 'commit', 'HEAD']);
  const split = original.indexOf(Buffer.from('\n\n'));
  const encoded = Buffer.concat([original.subarray(0, split), Buffer.from('\nencoding ISO-8859-1\n\nold\n')]);
  const oid = repo.text(['hash-object', '-w', '-t', 'commit', '--stdin'], encoded);
  repo.git(['update-ref', 'HEAD', oid]);
  const plan = makePlan(repo, { ...settings, commitMessage: 'Общее сообщение' });
  applyPlan(plan);
  assert.equal(repo.text(['show', '-s', '--format=%B', 'HEAD']), 'Общее сообщение');
  assert(!repo.git(['cat-file', 'commit', 'HEAD']).includes(Buffer.from('\nencoding ')));
});

test('гонка тега не позволяет частично обновить ветку; чужой тег отклоняется до push', (t) => {
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

test('пустой сервер использует пустые lease и получает только выбранную историю', (t) => {
  const { repo, connection, git, server, before } = fixture(t);
  for (const ref of before) git(['--git-dir', server, 'update-ref', '-d', ref.name]);
  const plan = makePlan(repo, settings);
  applyPlan(plan);
  const push = preparePush(plan, 'origin', connection);
  assert(push.refs.every((ref) => ref.expected === ''));
  executePush(push, connection);
  const names = git(['--git-dir', server, 'for-each-ref', '--format=%(refname)']).toString().trim().split('\n');
  assert.deepEqual(names.sort(), plan.selected.map((ref) => ref.name).sort());
});

test('сетевой адаптер отключает helpers, askpass, redirects и произвольные SSH-команды', () => {
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
