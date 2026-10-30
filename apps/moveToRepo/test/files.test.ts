import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkEntries, maxFileSize, pathSegments, readSource, readSources, secretContent, secretName, targetPath } from '@moveToRepo/files';
import { describe, expect, test, type TestContext } from 'vitest';

function fixture(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'movetorepo-files-'));
  context.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('path segments', () => {
  test('accept plain relative paths and a leading ./ for sources', () => {
    expect(pathSegments('from-A/some1.txt', 'f')).toEqual(['from-A', 'some1.txt']);
    expect(pathSegments('./from-A/some1.txt', 'f', true)).toEqual(['from-A', 'some1.txt']);
    expect(pathSegments('a/My notes+v2@x.md', 'f')).toEqual(['a', 'My notes+v2@x.md']);
  });

  test.each([
    ['', /пустой путь/],
    ['/etc/passwd', /относительный путь/],
    ['../secret.txt', /выход из каталога/],
    ['a/../../b.txt', /выход из каталога/],
    ['a/./b.txt', /выход из каталога/],
    ['./a.txt', /выход из каталога/],
    ['a//b.txt', /пустой сегмент/],
    ['a/', /пустой сегмент/],
    ['.env', /начинается с точки/],
    ['a/.git/config', /начинается с точки/],
    ['.github/workflows/x.yml', /начинается с точки/],
    ['-rf', /недопустимые символы/],
    ['a\\b.txt', /недопустимые символы/],
    ['a/b\nc.txt', /недопустимые символы/],
    ['a/b‮c.txt', /недопустимые символы/],
    ['файл.txt', /недопустимые символы/],
    ['filе.txt', /недопустимые символы/],
    ['a  b.txt', /недопустимые символы/],
    [' a.txt', /недопустимые символы/],
    ['a.txt ', /заканчиваться/],
    ['a.', /заканчиваться/],
    ['a:b', /недопустимые символы/],
    ['a*b', /недопустимые символы/],
    ['x'.repeat(1025), /длиннее/]
  ])('reject %j', (value, message) => {
    expect(() => pathSegments(value, 'f')).toThrow(message);
  });

  test('a leading ./ is accepted only for sources', () => {
    expect(() => pathSegments('./a.txt', 'dest')).toThrow(/выход из каталога/);
  });
});

describe('secret detection', () => {
  test.each(['server.pem', 'Server.KEY', 'cert.p12', 'store.jks', 'id_rsa', 'id_ed25519.pub', 'prod.env', 'credentials.json', 'credentials', 'terraform.tfstate'])(
    'name %s is a secret file',
    (name) => {
      expect(secretName(name)).toBeDefined();
    }
  );

  test.each(['readme.md', 'key-notes.txt', 'keys.txt', 'environment.ts', 'pem'])('name %s is not a secret file', (name) => {
    expect(secretName(name)).toBeUndefined();
  });

  test('contents with known token formats are found', () => {
    expect(secretContent(Buffer.from(`-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nabc`))).toBe('закрытый ключ');
    expect(secretContent(Buffer.from(`token=ghp_${'a'.repeat(36)}`))).toBe('токен GitHub');
    // Build token-like values at run time, so the repository secret scan does not find them in the source.
    expect(secretContent(Buffer.from(['AKIA', 'Q3EGRTZ7WJ5X2KLM'].join('')))).toBe('ключ AWS');
    expect(secretContent(Buffer.from('plain text'))).toBeUndefined();
  });
});

describe('destinations', () => {
  test('the file name goes into the destination directory', () => {
    expect(targetPath('./from-A/some1.txt', 'to-A')).toBe('to-A/some1.txt');
    expect(targetPath('some.txt', 'docs/notes')).toBe('docs/notes/some.txt');
    expect(targetPath('a/some.txt', '.')).toBe('some.txt');
    expect(() => targetPath('a.txt', '../x')).toThrow(/выход из каталога/);
    expect(() => targetPath('a.txt', '.github')).toThrow(/начинается с точки/);
    expect(() => targetPath('a.txt', '/abs')).toThrow(/относительный путь/);
  });

  test('duplicate destinations are rejected, also without letter case', () => {
    expect(() =>
      checkEntries([
        { source: 'a/x.txt', target: 'd/x.txt' },
        { source: 'b/x.txt', target: 'd/x.txt' }
      ])
    ).toThrow(/один путь/);
    expect(() =>
      checkEntries([
        { source: 'a/X.txt', target: 'd/X.txt' },
        { source: 'b/x.txt', target: 'd/x.txt' }
      ])
    ).toThrow(/один путь/);
  });

  test('secret names are rejected in sources and destinations', () => {
    expect(() => checkEntries([{ source: 'a/server.pem', target: 'd/server.pem' }])).toThrow(/секретами/);
    expect(() => checkEntries([{ source: 'credentials/a.txt', target: 'd/a.txt' }])).toThrow(/секретами/);
    expect(() => checkEntries([{ source: 'a.txt', target: 'keys.key/a.txt' }])).toThrow(/секретами/);
    expect(() => checkEntries([])).toThrow(/Не указаны файлы/);
  });
});

// moveToRepo supports only macOS and Linux. File modes, links, and O_NOFOLLOW are POSIX behavior.
describe.skipIf(process.platform === 'win32')('reading sources', () => {
  test('a regular file is read with its executable bit', (context) => {
    const root = fixture(context);
    mkdirSync(join(root, 'from-A'));
    writeFileSync(join(root, 'from-A/some1.txt'), 'one');
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    expect(readSource(root, './from-A/some1.txt')).toEqual({ content: Buffer.from('one'), executable: false });
    expect(readSource(root, 'run.sh').executable).toBe(true);
  });

  test('a symbolic link to a file outside the directory is rejected', (context) => {
    const root = fixture(context);
    const outside = fixture(context);
    writeFileSync(join(outside, 'id'), 'private');
    symlinkSync(join(outside, 'id'), join(root, 'notes.txt'));
    expect(() => readSource(root, 'notes.txt')).toThrow(/Символические ссылки/);
  });

  test('a symbolic link in a directory segment is rejected', (context) => {
    const root = fixture(context);
    const outside = fixture(context);
    writeFileSync(join(outside, 'a.txt'), 'private');
    symlinkSync(outside, join(root, 'dir'));
    expect(() => readSource(root, 'dir/a.txt')).toThrow(/Символические ссылки/);
  });

  test('hard links, directories, missing files, and large files are rejected', (context) => {
    const root = fixture(context);
    writeFileSync(join(root, 'a.txt'), 'a');
    linkSync(join(root, 'a.txt'), join(root, 'b.txt'));
    expect(() => readSource(root, 'b.txt')).toThrow(/жёсткими ссылками/);
    mkdirSync(join(root, 'dir'));
    expect(() => readSource(root, 'dir')).toThrow(/обычный файл/);
    expect(() => readSource(root, 'none.txt')).toThrow(/не найден/);
    writeFileSync(join(root, 'file'), 'x');
    expect(() => readSource(root, 'file/x.txt')).toThrow(/не найден/);
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(maxFileSize + 1));
    expect(() => readSource(root, 'big.bin')).toThrow(/больше/);
  });

  test('a file with a private key in its contents is rejected', (context) => {
    const root = fixture(context);
    writeFileSync(join(root, 'notes.txt'), `-----BEGIN RSA ${'PRIVATE'} KEY-----\n`);
    expect(() => readSources(root, [{ source: 'notes.txt', target: 'notes.txt' }])).toThrow(/похож на секрет/);
  });
});
