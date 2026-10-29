import { test } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, openSync, closeSync, ftruncateSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Repository, runGit, makePlan, applyPlan, writeObjects, findGitExecutable, terminalJSON } from '@reHistory/engine';
import { preparePush, networkGit, type PushTransport } from '@reHistory/remote';
import { exportPlan, verifyExport } from '@reHistory/export';
import { auditRepository } from '@reHistory/audit';

function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'rehistory-hardening-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  runGit(root, ['init', '-q', '--template=', '-b', 'main', join(root, 'source')]);
  const repo = new Repository(join(root, 'source'));
  repo.git(['config', 'user.name', 'Fixture']);
  repo.git(['config', 'user.email', 'fixture@example.org']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'fixture']);
  return { root, repo };
}
const settings = { start: 1700000000, interval: 1 };
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));

test('поиск Git игнорирует пустые и относительные PATH-каталоги на POSIX и Windows', () => {
  const posix: string[] = [];
  assert.equal(
    findGitExecutable(':.:relative:/trusted/bin', 'linux', (path) => {
      posix.push(path);
      return path;
    }),
    '/trusted/bin/git'
  );
  assert.deepEqual(posix, ['/trusted/bin/git']);
  const windows: string[] = [];
  assert.equal(
    findGitExecutable(';.;relative;C:relative;\\rooted;"C:\\Program Files\\Git\\cmd"', 'win32', (path) => {
      windows.push(path);
      return path;
    }),
    'C:\\Program Files\\Git\\cmd\\git.exe'
  );
  assert.deepEqual(windows, ['C:\\Program Files\\Git\\cmd\\git.exe']);
  assert.throws(() => findGitExecutable('.:relative:', 'linux', () => assert.fail('relative path probed')), /Git не найден/);
});

test('audit запускает Git из PATH, а не подложенный executable в cwd', (t) => {
  const { root, repo } = fixture(t);
  const marker = join(root, 'executed');
  const impostor = join(repo.path, process.platform === 'win32' ? 'git.exe' : 'git');
  if (process.platform === 'win32') copyFileSync(process.execPath, impostor);
  else writeFileSync(impostor, `#!/bin/sh\nprintf ran > '${marker}'\nexit 19\n`, { mode: 0o755 });
  repo.git(['add', '--', process.platform === 'win32' ? 'git.exe' : 'git']);
  repo.git(['commit', '-q', '-m', 'synthetic executable']);
  const result = spawnSync(process.execPath, [cli, '--audit', '--json'], { cwd: repo.path, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, true);
  assert.equal(existsSync(marker), false);
});

for (const key of ['http.sslVerify', 'http.https://example.invalid/.sslVerify', 'http.https://example.invalid/.followRedirects', 'http.extraHeader', 'http.proxy', 'http.sslCAInfo']) {
  test(`сетевой адаптер и подготовка push отклоняют ${key} до соединения`, (t) => {
    const { repo } = fixture(t);
    repo.git(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    repo.git(['config', key, 'false']);
    const plan = makePlan(repo, settings);
    applyPlan(plan);
    const connection: PushTransport = { refs: () => assert.fail('network read'), push: () => assert.fail('network write') };
    assert.throws(() => preparePush(plan, 'origin', connection), /HTTP-настройки/);
    assert.throws(() => networkGit(repo, ['ls-remote', 'https://example.invalid/repo.git']), /HTTP-настройки/);
  });
}

for (const kind of ['clean', 'process', 'smudge']) {
  test(`filter.${kind} блокируется до status; аудит не исполняет фильтр`, (t) => {
    const { root, repo } = fixture(t);
    writeFileSync(join(repo.path, '.gitattributes'), 'data filter=fixture\n');
    writeFileSync(join(repo.path, 'data'), 'content\n');
    repo.git(['add', '--', '.gitattributes', 'data']);
    repo.git(['commit', '-q', '-m', 'attributes']);
    const marker = join(root, 'filter-ran');
    const script = join(root, 'filter.cjs');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write(require('node:fs').readFileSync(0));`);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    repo.git(['config', `filter.fixture.${kind}`, `${quote(process.execPath)} ${quote(script)}`]);
    utimesSync(join(repo.path, 'data'), new Date(), new Date(Date.now() + 10000));
    assert.throws(() => makePlan(repo, settings), /Git-фильтры не поддерживаются/);
    assert.equal(auditRepository(repo).complete, true);
    assert.equal(existsSync(marker), false);
  });
}

test('JSON экранирует C1 и Cf, сохраняя значения и supplementary Unicode', () => {
  const original = { identity: 'name\u009b31m\u202e\u200b\u{e0001}', path: 'normal', c0: '\u001b' };
  const result = terminalJSON(original);
  assert(!/[\u0080-\u009f\p{Cf}]/u.test(result));
  assert.deepEqual(JSON.parse(result), original);
  assert(result.includes('\\u009b'));
  assert(result.includes('\\udb40\\udc01'));
});

test('audit --json экранирует управляющую идентичность тега', (t) => {
  const { repo } = fixture(t);
  const raw = Buffer.from(`object ${repo.text(['rev-parse', 'HEAD'])}\ntype commit\ntag unsafe\ntagger name\u009b31m\u202e <fixture@example.org> 1700000000 +0000\n\ntag\n`);
  const oid = repo.text(['hash-object', '-w', '-t', 'tag', '--stdin'], raw);
  repo.git(['update-ref', 'refs/tags/unsafe', oid]);
  const result = spawnSync(process.execPath, [cli, '--repo', repo.path, '--audit', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert(!/[\u0080-\u009f\p{Cf}]/u.test(result.stdout));
  assert(JSON.stringify(JSON.parse(result.stdout)).includes('name\u009b31m\u202e'));
});

test('NUL в старом коммите отклоняется до любых записей независимо от версии Git', (t) => {
  const { repo } = fixture(t);
  const original = repo.git(['cat-file', 'commit', 'HEAD']);
  const raw = Buffer.concat([original.subarray(0, original.indexOf('\n\n') + 2), Buffer.from([65, 0, 66])]);
  const oid = repo.text(['hash-object', '--literally', '-w', '-t', 'commit', '--stdin'], raw);
  repo.git(['update-ref', 'HEAD', oid]);
  const refs = repo.refs();
  assert.throws(() => makePlan(repo, settings), /содержит NUL/);
  assert.deepEqual(repo.refs(), refs);
  assert.equal(existsSync(join(repo.common, 'rehistory.lock')), false);
});

test('оставшаяся блокировка показывает PID и не удаляется автоматически', (t) => {
  const { repo } = fixture(t);
  const plan = makePlan(repo, settings);
  const file = join(repo.common, 'rehistory.lock');
  writeFileSync(file, '12345\n');
  assert.throws(() => applyPlan(plan), /PID: 12345.*Удаляйте lock/);
  assert.equal(readFileSync(file, 'utf8'), '12345\n');
});

test('экспорт файла больше 256 МиБ не буферизует blob в stdout Node.js', (t) => {
  const { repo, root } = fixture(t);
  const file = join(repo.path, 'large.bin');
  const fd = openSync(file, 'wx');
  ftruncateSync(fd, 257 * 1024 * 1024);
  closeSync(fd);
  repo.git(['add', '--', 'large.bin']);
  repo.git(['commit', '-q', '-m', 'large content']);
  const blob = repo.text(['rev-parse', 'HEAD:large.bin']);
  const target = join(root, 'export.git');
  exportPlan(makePlan(repo, settings), target);
  assert.equal(verifyExport(target).ok, true);
  const output = new Repository(target);
  assert.equal(output.text(['rev-parse', 'HEAD:large.bin']), blob);
  assert.equal(output.text(['cat-file', '-s', blob]), String(257 * 1024 * 1024));
});

test('pack метаданных сохраняет байты на границах кодирования размера', (t) => {
  const { repo } = fixture(t);
  const original = repo.git(['cat-file', 'commit', 'HEAD']);
  const headers = original.subarray(0, original.indexOf('\n\n') + 2);
  const objects = [2047, 2048, 262143, 262144].map((size) => {
    const data = Buffer.concat([headers, Buffer.alloc(size - headers.length, 65)]);
    return { type: 'commit' as const, data, oid: repo.text(['hash-object', '-t', 'commit', '--stdin'], data) };
  });
  writeObjects(repo, objects);
  for (const object of objects) assert.deepEqual(repo.git(['cat-file', 'commit', object.oid]), object.data);
});

test.skipIf(process.platform === 'win32')('SIGINT родителя во время apply не оставляет lock и восстанавливает обработчики', (t) => {
  const { repo, root } = fixture(t);
  const script = join(root, 'interrupt.mjs');
  const module = new URL('../dist/src/engine.js', import.meta.url).href;
  writeFileSync(
    script,
    `
    import { Repository, makePlan, applyPlan } from ${JSON.stringify(module)};
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    const repo = new Repository(${JSON.stringify(repo.path)});
    const plan = makePlan(repo, ${JSON.stringify(settings)});
    const original = repo.git.bind(repo);
    repo.git = (...args) => {
      if (args[0][0] === 'index-pack') process.kill(process.pid, 'SIGINT');
      return original(...args);
    };
    const before = process.listenerCount('SIGINT');
    const result = applyPlan(plan);
    setImmediate(() => setImmediate(() => console.log(JSON.stringify({ interrupted: result.interrupted, lock: existsSync(join(repo.common, 'rehistory.lock')), handlersRestored: before === process.listenerCount('SIGINT') }))));
  `
  );
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { interrupted: true, lock: false, handlersRestored: true });
});

test('status не запускает clean-фильтр внутри инициализированного подмодуля', (t) => {
  const { repo, root } = fixture(t);
  const path = join(repo.path, 'sub');
  repo.git(['init', '-q', '--template=', '-b', 'main', path]);
  const child = new Repository(path);
  child.git(['config', 'user.name', 'Fixture']);
  child.git(['config', 'user.email', 'fixture@example.org']);
  writeFileSync(join(path, '.gitattributes'), 'data filter=fixture\n');
  writeFileSync(join(path, 'data'), 'content\n');
  child.git(['add', '--', '.gitattributes', 'data']);
  child.git(['commit', '-q', '-m', 'submodule']);
  repo.git(['update-index', '--add', '--cacheinfo', `160000,${child.text(['rev-parse', 'HEAD'])},sub`]);
  repo.git(['commit', '-q', '-m', 'gitlink']);
  const marker = join(root, 'sub-filter-ran');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  child.git(['config', 'filter.fixture.clean', `touch ${quote(marker)}`]);
  utimesSync(join(path, 'data'), new Date(), new Date(Date.now() + 10000));
  assert.throws(() => makePlan(repo, settings), /Git-фильтры/);
  assert.equal(existsSync(marker), false);
});

test('verify-export --json экранирует управляющие символы в пути', (t) => {
  const { root, repo } = fixture(t);
  const path = join(root, 'export\u202erepo.git');
  exportPlan(makePlan(repo, settings), path);
  const result = spawnSync(process.execPath, [cli, '--verify-export', path, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert(!/[\u0080-\u009f\p{Cf}]/u.test(result.stdout));
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert(JSON.parse(result.stdout).repository.includes('\u202e'));
});

test('история больше одного batch обрабатывается без процесса на каждый коммит', (t) => {
  const { repo, root } = fixture(t);
  const raw = repo.git(['cat-file', 'commit', 'HEAD']);
  const split = raw.indexOf('\n\n');
  const headers = raw.subarray(0, split).toString();
  let parent = repo.text(['rev-parse', 'HEAD']);
  const history = [];
  for (let index = 0; index < 130; index++) {
    const data = Buffer.from(headers.replace('\n', `\nparent ${parent}\n`) + `\n\nmessage ${index}\n`);
    const oid = createHash('sha1').update(`commit ${data.length}\0`).update(data).digest('hex');
    history.push({ type: 'commit' as const, data, oid });
    parent = oid;
  }
  writeObjects(repo, history);
  repo.git(['update-ref', 'HEAD', parent]);
  const original = repo.git.bind(repo);
  const calls: string[][] = [];
  repo.git = (...args) => {
    calls.push(args[0]);
    return original(...args);
  };
  const plan = makePlan(repo, settings);
  assert.equal(plan.commits, 131);
  assert.equal(calls.filter((args) => args[0] === 'cat-file' && args[1] === '--batch').length, 2);
  assert(!calls.some((args) => args[0] === 'hash-object'));
  applyPlan(plan);
  assert.equal(calls.filter((args) => args[0] === 'index-pack').length, 1);
  const audit = auditRepository(repo);
  assert.equal(audit.complete, true);
  assert.equal(audit.commits.length, 262);
  const target = join(root, 'batch.git');
  exportPlan(makePlan(repo, settings), target);
  assert.equal(verifyExport(target).ok, true);
});

test('многострочные значения config не подменяют список имён настроек', (t) => {
  const { repo } = fixture(t);
  repo.git(['config', 'rehistory.note', 'note\nfilter.fake.clean=cat']);
  assert.equal(makePlan(repo, settings).commits, 1);
  repo.git(['config', 'filter.driver.clean', 'cat\ncat']);
  assert.throws(() => makePlan(repo, settings), /Git-фильтры/);
});

for (const completion of ['microtask', 'stdin']) {
  test.skipIf(process.platform === 'win32')(`CLI после SIGINT во время JS: подтверждение через ${completion}, код 130 без push`, (t) => {
    const { repo, root } = fixture(t);
    const previous = repo.text(['rev-parse', 'HEAD']);
    const preload = join(root, 'interrupt-cli.mjs');
    const marker = join(root, 'push-offered');
    const engine = new URL('../dist/src/engine.js', import.meta.url).href;
    const prompts = new URL('../dist/src/prompts.js', import.meta.url).href;
    writeFileSync(
      preload,
      `
    import { Repository } from ${JSON.stringify(engine)};
    import { TerminalPrompts } from ${JSON.stringify(prompts)};
    import { writeFileSync } from 'node:fs';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    TerminalPrompts.prototype.text = async (_question, initial) => initial;
    TerminalPrompts.prototype.confirm = async question => {
      if (question === 'Применить изменения?' && ${JSON.stringify(completion)} === 'stdin') {
        await new Promise(resolve => {
          process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
          process.stdin.resume();
        });
      }
      if (question === 'Сделать push?') writeFileSync(${JSON.stringify(marker)}, 'offered');
      return question === 'Применить изменения?' || question === 'Нормализовать даты тегов?';
    };
    const original = Repository.prototype.git;
    Repository.prototype.git = function(...args) {
      const result = original.apply(this, args);
      if (args[0][0] === 'update-ref' && args[0].includes('-m')) {
        process.kill(process.pid, 'SIGINT');
        const end = Date.now() + 20;
        while (Date.now() < end) { /* Keep the signal queued during JavaScript work. */ }
      }
      return result;
    };
  `
    );
    const result = spawnSync(process.execPath, ['--import', preload, cli, '--repo', repo.path], {
      input: 'confirm\n',
      encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color' },
      timeout: 30000
    });
    assert.equal(result.status, 130, result.stdout + result.stderr);
    assert(result.stdout.includes('Локальная история сохранена'));
    assert(!result.stdout.includes('Сделать push?'));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(repo.common, 'rehistory.lock')), false);
    assert.notEqual(repo.text(['rev-parse', 'HEAD']), previous);
  });
}

test('несколько синхронных применений используют один SIGINT-обработчик и очищают его после turn', async (t) => {
  const { repo } = fixture(t);
  await nextTurn();
  await nextTurn();
  const before = process.listenerCount('SIGINT');
  for (let index = 0; index < 12; index++) {
    applyPlan(makePlan(repo, { ...settings, start: settings.start + index }));
    assert.equal(process.listenerCount('SIGINT'), before + 1);
  }
  await nextTurn();
  await nextTurn();
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('checkout с core.autocrlf=true сохраняет LF для Prettier и исключения для bat/binary', (t) => {
  const { repo } = fixture(t);
  writeFileSync(join(repo.path, '.gitattributes'), readFileSync(new URL('../../../.gitattributes', import.meta.url)));
  repo.git(['config', 'core.autocrlf', 'true']);
  const files = new Map([
    ['sample.ts', Buffer.from('export const answer = 1;\n')],
    ['sample.mjs', Buffer.from('export const answer = 1;\n')],
    ['package.json', Buffer.from('{}\n')],
    ['.prettierrc', Buffer.from('{}\n')],
    ['README.md', Buffer.from('# Fixture\n')],
    ['sample.bat', Buffer.from('echo fixture\n')],
    ['payload.exe', Buffer.from([0, 10, 13, 255])]
  ]);
  for (const [name, data] of files) writeFileSync(join(repo.path, name), data);
  repo.git(['add', '--', '.gitattributes', ...files.keys()]);
  repo.git(['commit', '-q', '-m', 'line ending fixture']);
  for (const name of files.keys()) rmSync(join(repo.path, name));
  repo.git(['checkout', 'HEAD', '--', ...files.keys()]);
  for (const [name, data] of files) {
    const expected = name.endsWith('.bat') ? Buffer.from(data.toString().replaceAll('\n', '\r\n')) : data;
    assert.deepEqual(readFileSync(join(repo.path, name)), expected, name);
  }
});
