import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stamp } from '@reHistory/audit';
import { remoteGate } from '@reHistory/cli';
import { applyPlan, makePlan, type Options, Repository, runGit, validateOptions } from '@reHistory/engine';
import { exportPlan, manifestName, verifyExport } from '@reHistory/export';
import { remoteCopy } from '@reHistory/remote';
import { test } from 'vitest';

function temp(t: { onTestFinished: (fn: () => void) => void }): string {
  const path = mkdtempSync(join(tmpdir(), 'rehistory-flows-'));
  t.onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function fixture(t: { onTestFinished: (fn: () => void) => void }, format = 'sha1'): Repository {
  const root = temp(t);
  runGit(root, ['init', '-q', '--template=', '--initial-branch=main', `--object-format=${format}`, join(root, 'source')]);
  const repo = new Repository(join(root, 'source'));
  repo.git(['config', 'user.name', 'Исходный автор']);
  repo.git(['config', 'user.email', 'old@example.org']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'первый'], undefined, { GIT_AUTHOR_DATE: '1600000000 +0300', GIT_COMMITTER_DATE: '1600000002 +0300' });
  repo.git(['commit', '-q', '--allow-empty', '-m', 'второй'], undefined, { GIT_AUTHOR_DATE: '1600000100 -0500', GIT_COMMITTER_DATE: '1600000200 -0500' });
  repo.git(['tag', '-a', '-m', 'Релиз', 'release'], undefined, { GIT_COMMITTER_DATE: '1600000300 +0100' });
  return repo;
}
function commits(repo: Repository): string[] {
  return repo.text(['log', '--reverse', '--format=%an|%ae|%cn|%ce|%ad|%cd|%B', '--date=raw']).split('\n').filter(Boolean);
}
function tagger(repo: Repository): ReturnType<typeof stamp> {
  return stamp(repo.git(['cat-file', 'tag', 'release']), 'tagger');
}
const identity = { name: 'Новый автор', email: 'new@example.org' };

test('флоу не принимает параметры других флоу и неизвестные флоу', () => {
  const invalid: unknown[] = [
    undefined,
    {},
    { flow: 'all', start: 1, interval: 1 },
    { flow: 'dates', start: 1700000000, interval: 1, identity },
    { flow: 'dates', start: 1700000000, interval: 1, commitMessage: 'x' },
    { flow: 'dates', start: 1700000000, interval: 1, tagIdentity: identity },
    { flow: 'dates', start: 1700000000, interval: 0 },
    { flow: 'dates', start: -1, interval: 1 },
    { flow: 'authors' },
    { flow: 'authors', identity, start: 1700000000 },
    { flow: 'authors', identity, commitMessage: 'x' },
    { flow: 'authors', identity: { name: 'x', email: 'bad' } },
    { flow: 'authors', identity, tagIdentity: { name: '<x>', email: 'x@example.org' } },
    { flow: 'messages' },
    { flow: 'messages', commitMessage: 'x', identity },
    { flow: 'messages', commitMessage: 'x', interval: 1 },
    { flow: 'messages', commitMessage: '\u001b[31m' },
    { flow: 'messages', commitMessage: 'x', backupBranch: 1 }
  ];
  for (const options of invalid) assert.throws(() => validateOptions(options as Options), Error, JSON.stringify(options));
  validateOptions({ flow: 'dates', start: 1700000000, interval: 1, tagPolicy: 'preserve', backupBranch: 'backup' });
  validateOptions({ flow: 'authors', identity, tagIdentity: identity });
  validateOptions({ flow: 'messages', commitMessage: 'Сообщение' });
});

test('флоу времени меняет только даты коммитов и тегов', (t) => {
  const repo = fixture(t);
  const before = commits(repo);
  const tag = tagger(repo);
  applyPlan(makePlan(repo, { flow: 'dates', start: 1700000000, interval: 5 }));
  const after = commits(repo);
  for (const [index, line] of after.entries()) {
    const old = before[index].split('|');
    const next = line.split('|');
    assert.deepEqual(next.slice(0, 4), old.slice(0, 4));
    assert.deepEqual(next.slice(4, 6), [`${1700000000 + index * 5} +0000`, `${1700000000 + index * 5} +0000`]);
    assert.deepEqual(next.slice(6), old.slice(6));
  }
  assert.deepEqual(tagger(repo), { identity: tag.identity, timestamp: 1700000005, timezone: '+0000' });
  assert.equal(repo.text(['for-each-ref', '--format=%(contents)', 'refs/tags/release']), 'Релиз');
});

test('флоу авторов сохраняет даты, часовые пояса и сообщения', (t) => {
  const repo = fixture(t);
  const before = commits(repo);
  const tag = tagger(repo);
  applyPlan(makePlan(repo, { flow: 'authors', identity }));
  for (const [index, line] of commits(repo).entries()) {
    const old = before[index].split('|');
    const next = line.split('|');
    assert.deepEqual(next.slice(0, 4), [identity.name, identity.email, identity.name, identity.email]);
    assert.deepEqual(next.slice(4), old.slice(4));
  }
  // Without a tag identity, tags keep their creator and date.
  assert.deepEqual(tagger(repo), tag);
});

test('флоу авторов меняет создателя тега без изменения его даты', (t) => {
  const repo = fixture(t);
  const tag = tagger(repo);
  applyPlan(makePlan(repo, { flow: 'authors', identity, tagIdentity: identity }));
  assert.deepEqual(tagger(repo), { identity: `${identity.name} <${identity.email}>`, timestamp: tag.timestamp, timezone: tag.timezone });
});

test('флоу сообщений сохраняет даты, авторов и теги', (t) => {
  const repo = fixture(t);
  const before = commits(repo);
  const tag = tagger(repo);
  const plan = makePlan(repo, { flow: 'messages', commitMessage: 'Общее сообщение' });
  applyPlan(plan);
  for (const [index, line] of commits(repo).entries()) {
    const old = before[index].split('|');
    const next = line.split('|');
    assert.deepEqual(next.slice(0, 6), old.slice(0, 6));
    assert.equal(next.slice(6).join('|'), 'Общее сообщение');
  }
  assert.deepEqual(tagger(repo), tag);
  assert.equal(repo.text(['for-each-ref', '--format=%(contents)', 'refs/tags/release']), 'Релиз');
  // A second run with the same message gives the same objects.
  const again = makePlan(repo, { flow: 'messages', commitMessage: 'Общее сообщение' });
  assert(again.selected.every((ref) => again.mapping.get(ref.oid) === ref.oid));
});

for (const format of ['sha1', 'sha256'])
  test(`экспорт ${format} проверяет каждый флоу по его манифесту`, (t) => {
    const cases: [Options, (policy: Record<string, unknown>) => void, RegExp][] = [
      [{ flow: 'dates', start: 1700000000, interval: 3, tagPolicy: 'normalize' }, (policy) => (policy.start = 1700000001), /даты коммита/],
      [{ flow: 'authors', identity, tagIdentity: identity }, (policy) => (policy.identity = { name: 'Другой', email: 'other@example.org' }), /идентичность коммита/],
      [{ flow: 'messages', commitMessage: 'Общее сообщение' }, (policy) => (policy.commitMessage = 'Подмена'), /сообщение коммита/]
    ];
    for (const [index, [options, tamper, error]] of cases.entries()) {
      const repo = fixture(t, format);
      const target = join(repo.path, '..', `export-${index}.git`);
      exportPlan(makePlan(repo, options), target);
      const file = join(target, manifestName);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(manifest.version, 2);
      assert.equal(manifest.policy.flow, options.flow);
      assert.equal(verifyExport(target).ok, true);
      tamper(manifest.policy);
      writeFileSync(file, JSON.stringify(manifest));
      const report = verifyExport(target);
      assert.equal(report.ok, false);
      assert(
        report.errors.some((item) => error.test(item)),
        report.errors.join('\n')
      );
    }
  });

test('экспорт старого формата (version 1) проверяется как нормализация дат', (t) => {
  const repo = fixture(t);
  const target = join(repo.path, '..', 'legacy.git');
  exportPlan(makePlan(repo, { flow: 'dates', start: 1700000000, interval: 2, tagPolicy: 'normalize' }), target);
  const file = join(target, manifestName);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, version: 1, policy: { start: 1700000000, interval: 2, tagPolicy: 'normalize' } }));
  assert.equal(verifyExport(target).ok, true);
  writeFileSync(file, JSON.stringify({ ...manifest, version: 1, policy: { start: 1700000000, interval: 2, tagPolicy: 'normalize', identity } }));
  assert(verifyExport(target).errors.some((item) => /идентичность коммита/.test(item)));
});

test('незапушенные коммиты определяются по локальным remote-веткам', (t) => {
  const repo = fixture(t);
  const head = (): string => repo.text(['rev-parse', 'HEAD']);
  assert.deepEqual(remoteCopy(repo, head()), { tracking: 0, unpushed: 2 });
  repo.git(['update-ref', 'refs/remotes/origin/main', head()]);
  repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  assert.deepEqual(remoteCopy(repo, head()), { tracking: 1, unpushed: 0 });
  repo.git(['commit', '-q', '--allow-empty', '-m', 'третий']);
  assert.deepEqual(remoteCopy(repo, head()), { tracking: 1, unpushed: 1 });
  // Any remote-tracking ref that contains the commits counts as a remote copy.
  repo.git(['update-ref', 'refs/remotes/fork/feature', head()]);
  assert.deepEqual(remoteCopy(repo, head()), { tracking: 2, unpushed: 0 });
});

test('решение о запуске: блокировка, подтверждение и предупреждения dry-run', () => {
  assert.equal(remoteGate({ tracking: 1, unpushed: 0 }, false), 'ok');
  assert.equal(remoteGate({ tracking: 1, unpushed: 0 }, true), 'ok');
  assert.equal(remoteGate({ tracking: 1, unpushed: 3 }, false), 'block');
  assert.equal(remoteGate({ tracking: 1, unpushed: 3 }, true), 'warn');
  assert.equal(remoteGate({ tracking: 0, unpushed: 3 }, false), 'confirm');
  assert.equal(remoteGate({ tracking: 0, unpushed: 3 }, true), 'notice');
});

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
/** Run the built CLI with scripted answers. Unknown questions stop the run. */
function runCli(root: string, repo: Repository, answers: Record<string, string | number | boolean>, args: string[] = []): { status: number | null; output: string; asked: string[] } {
  const preload = join(root, `answers-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const log = `${preload}.log`;
  const prompts = new URL('../dist/src/prompts.js', import.meta.url).href;
  writeFileSync(
    preload,
    `
    import { TerminalPrompts } from ${JSON.stringify(prompts)};
    import { appendFileSync } from 'node:fs';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    const answers = ${JSON.stringify(answers)};
    const answer = (question) => {
      appendFileSync(${JSON.stringify(log)}, question + '\\n');
      if (!(question in answers)) throw new Error('Неожиданный вопрос: ' + question);
      return answers[question];
    };
    TerminalPrompts.prototype.text = async (question) => answer(question);
    TerminalPrompts.prototype.confirm = async (question) => answer(question);
    TerminalPrompts.prototype.select = async (question) => answer(question);
  `
  );
  const result = spawnSync(process.execPath, ['--import', preload, cli, '--repo', repo.path, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' },
    timeout: 30000
  });
  const asked = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, output: result.stdout + result.stderr, asked };
}

test.skipIf(process.platform === 'win32')('CLI задаёт только вопросы выбранного флоу', (t) => {
  const root = temp(t);
  const flows: [number, Record<string, string | boolean>, string[]][] = [
    [
      0,
      { 'Интервал (в секундах)': '2', 'Дата первого коммита': '2024-01-01', 'Время первого коммита': '00:00:00Z', 'Нормализовать даты тегов?': true },
      ['Интервал (в секундах)', 'Дата первого коммита', 'Время первого коммита', 'Нормализовать даты тегов?']
    ],
    [1, { Имя: identity.name, Email: identity.email, 'То же имя/email для создателей тегов?': false }, ['Имя', 'Email', 'То же имя/email для создателей тегов?']],
    [2, { 'Новое сообщение': 'Общее сообщение' }, ['Новое сообщение']]
  ];
  for (const [choice, specific, expected] of flows) {
    const repo = fixture(t);
    repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD'])]);
    const before = commits(repo);
    const run = runCli(root, repo, { 'Что переписать?': choice, 'Создать бекап?': false, 'Применить изменения?': true, 'Сделать push?': false, ...specific });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.asked, ['Что переписать?', 'Создать бекап?', ...expected, 'Применить изменения?', 'Сделать push?']);
    const after = commits(repo).map((line) => line.split('|'));
    const old = before.map((line) => line.split('|'));
    if (choice === 0)
      assert.deepEqual(
        after.map((line) => line[4]),
        ['1704067200 +0000', '1704067202 +0000']
      );
    if (choice === 1)
      assert.deepEqual(
        after.map((line) => line.slice(0, 2)),
        old.map(() => [identity.name, identity.email])
      );
    if (choice === 2)
      assert.deepEqual(
        after.map((line) => line.slice(6).join('|')),
        ['Общее сообщение', 'Общее сообщение']
      );
    // A second run of any flow needs a push first.
    const blocked = runCli(root, repo, {});
    assert.equal(blocked.status, 1, blocked.output);
    assert.match(blocked.output, /Незапушенные коммиты: 2/);
    assert.deepEqual(blocked.asked, []);
  }
});

test.skipIf(process.platform === 'win32')('CLI без remote-веток требует явного подтверждения', (t) => {
  const root = temp(t);
  const repo = fixture(t);
  const head = repo.text(['rev-parse', 'HEAD']);
  const declined = runCli(root, repo, { 'Продолжить без копии на сервере?': false });
  assert.equal(declined.status, 0, declined.output);
  assert.match(declined.output, /Нет remote-веток/);
  assert.deepEqual(declined.asked, ['Продолжить без копии на сервере?']);
  assert.equal(repo.text(['rev-parse', 'HEAD']), head);
  // A dry-run shows the warning without a question and writes nothing.
  const dry = runCli(root, repo, { 'Что переписать?': 2, 'Создать бекап?': false, 'Новое сообщение': 'x' }, ['--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /Dry-run завершён/);
  assert.equal(repo.text(['rev-parse', 'HEAD']), head);
});

test.skipIf(process.platform === 'win32')('CLI с незапушенными коммитами: dry-run предупреждает, экспорт разрешён', (t) => {
  const root = temp(t);
  const repo = fixture(t);
  repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD~1'])]);
  const head = repo.text(['rev-parse', 'HEAD']);
  const dry = runCli(root, repo, { 'Что переписать?': 1, 'Создать бекап?': false, Имя: identity.name, Email: identity.email, 'То же имя/email для создателей тегов?': true }, ['--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /Незапушенные коммиты: 1\. .*Без dry-run запуск будет остановлен/);
  const target = join(root, 'export.git');
  const exported = runCli(root, repo, { 'Что переписать?': 2, 'Новое сообщение': 'Общее сообщение', 'Создать экспорт?': true }, ['--export', target]);
  assert.equal(exported.status, 0, exported.output);
  assert.equal(verifyExport(target).ok, true);
  assert.equal(repo.text(['rev-parse', 'HEAD']), head);
});

test.skipIf(process.platform === 'win32')('CLI не применяет план без изменений', (t) => {
  const root = temp(t);
  const repo = fixture(t);
  repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD'])]);
  const first = runCli(root, repo, { 'Что переписать?': 2, 'Создать бекап?': false, 'Новое сообщение': 'Одно', 'Применить изменения?': true, 'Сделать push?': false });
  assert.equal(first.status, 0, first.output);
  repo.git(['update-ref', 'refs/remotes/origin/main', repo.text(['rev-parse', 'HEAD'])]);
  const head = repo.text(['rev-parse', 'HEAD']);
  const again = runCli(root, repo, { 'Что переписать?': 2, 'Создать бекап?': true, 'Ветка бекапа': 'backup', 'Новое сообщение': 'Одно' });
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /Изменений нет/);
  assert.equal(repo.text(['rev-parse', 'HEAD']), head);
  assert.throws(() => repo.text(['rev-parse', '--verify', 'refs/heads/backup']));
});

test('план останавливается, если в хранилище нет дерева коммита', (t) => {
  const repo = fixture(t);
  writeFileSync(join(repo.path, 'file.txt'), 'data\n');
  repo.git(['add', '--', 'file.txt']);
  repo.git(['commit', '-q', '-m', 'файл']);
  writeFileSync(join(repo.path, 'file.txt'), 'other\n');
  repo.git(['commit', '-q', '-am', 'другой файл']);
  const tree = repo.text(['rev-parse', 'HEAD~1^{tree}']);
  rmSync(join(repo.common, 'objects', tree.slice(0, 2), tree.slice(2)));
  const head = repo.text(['rev-parse', 'HEAD']);
  for (const options of [
    { flow: 'dates', start: 1700000000, interval: 1 },
    { flow: 'authors', identity },
    { flow: 'messages', commitMessage: 'x' }
  ] as Options[])
    assert.throws(() => makePlan(repo, options), new RegExp(`нет дерева ${tree}`));
  assert.equal(repo.text(['rev-parse', 'HEAD']), head);
});

test('запуск из подкаталога рабочего дерева использует корень репозитория', (t) => {
  const repo = fixture(t);
  mkdirSync(join(repo.path, 'apps', 'tool'), { recursive: true });
  writeFileSync(join(repo.path, 'apps', 'tool', 'file.txt'), 'data\n');
  repo.git(['add', '--', 'apps/tool/file.txt']);
  repo.git(['commit', '-q', '-m', 'файл в подкаталоге']);
  const nested = new Repository(join(repo.path, 'apps', 'tool'));
  assert.equal(realpathSync.native(nested.path), realpathSync.native(repo.path));
  const plan = makePlan(nested, { flow: 'dates', start: 1700000000, interval: 1 });
  applyPlan(plan);
  assert.equal(repo.text(['rev-parse', 'HEAD']), plan.mapping.get(plan.headOid));
  repo.git(['fsck', '--strict', '--no-reflogs']);
});
