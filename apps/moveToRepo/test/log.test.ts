import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkLog, code, formatTime, logName, OperationLog, resultLine, startEntry } from '@moveToRepo/log';
import { describe, expect, test, type TestContext } from 'vitest';

function fixture(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'movetorepo-log-'));
  context.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const time = new Date('2026-01-02T14:04:05.678Z');

describe('log text', () => {
  test('the time has the local date, the UTC offset, and the UTC moment', () => {
    expect(formatTime(time)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2} \(UTC 2026-01-02T14:04:05Z\)$/);
  });

  test('inline code escapes backticks and control characters', () => {
    expect(code('a/b.txt')).toBe('`a/b.txt`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`a')).toBe('`` `a ``');
    expect(code('a\nb‮')).toBe('`a?b?`');
  });

  test('the entry is minimal English text with the source, the target, each file, and the result', () => {
    const text =
      startEntry({
        id: 'op-1',
        time,
        directory: '/home/me/work',
        repository: 'me/notes',
        base: 'main',
        branch: 'movetorepo/ab12cd34',
        commit: 'a'.repeat(40),
        files: [
          { source: './from-A/some1.txt', target: 'to-A/some1.txt', state: 'add' },
          { source: 'b.txt', target: 'b.txt', state: 'replace' }
        ]
      }) + resultLine('op-1', 'success', 'https://github.com/me/notes/pull/1');
    expect(text).toBe(
      [
        '',
        '## ID: `op-1`',
        '',
        `- Date: ${formatTime(time)}`,
        '- From: /home/me/work (`main`)',
        '- Target: https://github.com/me/notes (`movetorepo/ab12cd34`)',
        `- Commit: \`${'a'.repeat(40)}\``,
        '- files (2):',
        '  - `/home/me/work/from-A/some1.txt` → `to-A/some1.txt` (new)',
        '  - `/home/me/work/b.txt` → `b.txt` (replaced)',
        '- Result: https://github.com/me/notes/pull/1 (`success`, ID `op-1`)',
        ''
      ].join('\n')
    );
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test('control characters in plain fields cannot start new lines', () => {
    const text = startEntry({
      id: 'op-2',
      time,
      directory: '/home/me/a\n## ID: fake',
      repository: 'me/notes',
      base: 'main',
      branch: 'movetorepo/ab12cd34',
      commit: 'a'.repeat(40),
      files: []
    });
    expect(text).toContain('- From: /home/me/a?## ID: fake (`main`)');
    expect(text.match(/^## ID/gm)).toHaveLength(1);
    expect(resultLine('op-2', 'failed', 'push failed\n- Result: ok')).toBe('- Result: push failed?- Result: ok (`failed`, ID `op-2`)\n');
  });

  test('parallel results can be matched to their operations by ID', () => {
    const lines = [
      startEntry({ id: 'A', time, directory: '/d', repository: 'me/a', base: 'main', branch: 'movetorepo/a', commit: 'a'.repeat(40), files: [] }),
      startEntry({ id: 'B', time, directory: '/d', repository: 'me/b', base: 'main', branch: 'movetorepo/b', commit: 'b'.repeat(40), files: [] }),
      resultLine('A', 'failed', 'push failed'),
      resultLine('B', 'success', 'https://github.com/me/b/pull/1')
    ].join('');
    expect(lines).toContain('- Result: push failed (`failed`, ID `A`)');
    expect(lines).toContain('- Result: https://github.com/me/b/pull/1 (`success`, ID `B`)');
  });
});

describe.skipIf(process.platform === 'win32')('log file', () => {
  test('a new log gets a header and mode 0600, and later entries are appended', (context) => {
    const root = fixture(context);
    checkLog(root);
    const first = OperationLog.open(root);
    first.write('one\n');
    first.close();
    const second = OperationLog.open(root);
    second.write('two\n');
    second.close();
    const path = join(root, logName);
    expect(readFileSync(path, 'utf8')).toBe('# moveToRepo log\none\ntwo\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => first.write('x')).toThrow(/закрыт/);
  });

  test('an existing log readable by others is changed to mode 0600', (context) => {
    const root = fixture(context);
    writeFileSync(join(root, logName), 'old\n', { mode: 0o644 });
    chmodSync(join(root, logName), 0o644);
    OperationLog.open(root).close();
    expect(statSync(join(root, logName)).mode & 0o777).toBe(0o600);
  });

  test('a root replaced by a link after the start stops the log before it opens', (context) => {
    const root = realpathSync(fixture(context));
    const selected = join(root, 'selected');
    const other = join(root, 'other');
    mkdirSync(selected);
    mkdirSync(other);
    const before = statSync(selected);
    renameSync(selected, join(root, 'saved'));
    symlinkSync(other, selected);
    const id = { dev: before.dev, ino: before.ino };
    expect(() => OperationLog.open(selected, id)).toThrow(/изменился во время работы/);
    expect(() => checkLog(selected, id)).toThrow(/изменился во время работы/);
    expect(() => statSync(join(other, logName))).toThrow();
  });

  test('an existing log is not truncated', (context) => {
    const root = fixture(context);
    writeFileSync(join(root, logName), 'old\n');
    const log = OperationLog.open(root);
    log.write('new\n');
    log.close();
    expect(readFileSync(join(root, logName), 'utf8')).toBe('old\nnew\n');
  });

  test('a symbolic link as the log is rejected and its target does not change', (context) => {
    const root = fixture(context);
    const outside = fixture(context);
    writeFileSync(join(outside, 'target'), 'keep');
    symlinkSync(join(outside, 'target'), join(root, logName));
    expect(() => checkLog(root)).toThrow(/символическая ссылка/);
    expect(() => OperationLog.open(root)).toThrow(/символическая ссылка/);
    // A dangling link must not create its target either.
    rmSync(join(outside, 'target'));
    expect(() => OperationLog.open(root)).toThrow(/символическая ссылка/);
    expect(() => statSync(join(outside, 'target'))).toThrow();
  });

  test('a log with a hard link or a directory as the log is rejected', (context) => {
    const root = fixture(context);
    writeFileSync(join(root, 'other'), 'x');
    linkSync(join(root, 'other'), join(root, logName));
    expect(() => checkLog(root)).toThrow(/жёсткие ссылки/);
    expect(() => OperationLog.open(root)).toThrow(/жёсткие ссылки/);
    expect(readFileSync(join(root, 'other'), 'utf8')).toBe('x');
  });
});
