import fs, { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkEntries, checkRoot, maxFileSize, pathSegments, readSource, readSources, secretContent, secretName, targetPath } from '@moveToRepo/files';
import { directoryId } from '@moveToRepo/tools';
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

  test('accept Russian Cyrillic names and Latin and Cyrillic words in one name', () => {
    expect(pathSegments('Манускрипты/Младшая Звезда.md', 'f')).toEqual(['Манускрипты', 'Младшая Звезда.md']);
    expect(pathSegments('__build/Младшая Звезда - beta - 0_3_0.docx', 'f')).toEqual(['__build', 'Младшая Звезда - beta - 0_3_0.docx']);
    expect(pathSegments('Ёлка/ёжик й.txt', 'f')).toEqual(['Ёлка', 'ёжик й.txt']);
  });

  test('a decomposed name is checked in the NFC form and keeps its given form', () => {
    const decomposed = 'Новый ёж.txt'.normalize('NFD');
    expect(decomposed).not.toBe('Новый ёж.txt');
    expect(pathSegments(decomposed, 'f')).toEqual([decomposed]);
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
    ['filе.txt', /смешаны в одном слове/],
    ['сredentials.json', /смешаны в одном слове/],
    ['Звeзда.md', /смешаны в одном слове/],
    ['a/Mладшая.md', /смешаны в одном слове/],
    ['ґ.txt', /недопустимые символы/],
    ['і.txt', /недопустимые символы/],
    ['α.txt', /недопустимые символы/],
    ['е\u0301.txt', /недопустимые символы/],
    ['а\u200bб.txt', /недопустимые символы/],
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

  test('a Cyrillic name goes into a Cyrillic or Latin directory in the NFC form', () => {
    expect(targetPath('__build/Младшая Звезда - beta - 0_3_0.epub', 'export')).toBe('export/Младшая Звезда - beta - 0_3_0.epub');
    expect(targetPath('Манускрипты/Младшая Звезда.md', 'Рукописи')).toBe('Рукописи/Младшая Звезда.md');
    expect(targetPath('Новый ёж.txt'.normalize('NFD'), 'Ёлка'.normalize('NFD'))).toBe('Ёлка/Новый ёж.txt'.normalize('NFC'));
  });

  test('the same name in two Unicode forms or in another letter case is one destination', () => {
    expect(() =>
      checkEntries([
        { source: 'a/ёж.txt', target: targetPath('a/ёж.txt', 'd') },
        { source: 'b/ёж.txt'.normalize('NFD'), target: targetPath('b/ёж.txt'.normalize('NFD'), 'd') }
      ])
    ).toThrow(/один путь/);
    expect(() =>
      checkEntries([
        { source: 'a/Звезда.md', target: 'd/Звезда.md' },
        { source: 'b/звезда.md', target: 'd/звезда.md' }
      ])
    ).toThrow(/один путь/);
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

  test('the operation log cannot be a source', () => {
    expect(() => checkEntries([{ source: 'a/__movetorepo-log.md', target: 'd/__movetorepo-log.md' }])).toThrow(/Журнал/);
    expect(() => checkEntries([{ source: '__MoveToRepo-Log.md', target: 'd/__MoveToRepo-Log.md' }])).toThrow(/Журнал/);
  });

  test('all extensions of a name are checked', () => {
    expect(secretName('terraform.tfstate.backup')).toBe('расширение .tfstate');
    expect(secretName('server.key.old')).toBe('расширение .key');
    expect(secretName('notes.txt')).toBeUndefined();
    expect(secretName('key')).toBeUndefined();
  });

  test.each([
    ['an OpenAI project key', `OPENAI_API_KEY=sk-${'proj'}-${'a'.repeat(40)}`],
    ['a Stripe key', `sk_${'live'}_${'a'.repeat(24)}`],
    ['a JWT', `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`]
  ])('contents with %s are rejected', (_, text) => {
    expect(secretContent(Buffer.from(text))).toBeDefined();
  });

  test('UTF-16 contents are checked', () => {
    const key = `-----BEGIN RSA ${'PRIVATE'} KEY-----\n`;
    expect(secretContent(Buffer.from(`\uFEFF${key}`, 'utf16le'))).toBe('закрытый ключ');
    expect(secretContent(Buffer.from(key, 'utf16le').swap16())).toBe('закрытый ключ');
    expect(secretContent(Buffer.from('plain text', 'utf16le'))).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('root directory', () => {
  test('a root inside a directory that starts with a dot is rejected', (context) => {
    const root = fixture(context);
    mkdirSync(join(root, '.docker/sub'), { recursive: true });
    writeFileSync(join(root, '.docker/config.json'), '{}');
    expect(() => checkRoot(join(root, '.docker'))).toThrow(/начинается с точки/);
    expect(() => checkRoot(join(root, '.docker/sub'))).toThrow(/начинается с точки/);
    expect(() => readSources(join(root, '.docker'), [{ source: 'config.json', target: 'config.json' }])).toThrow(/начинается с точки/);
    expect(() => checkRoot(root)).not.toThrow();
  });

  test('a link to a directory that starts with a dot is rejected by its real path', (context) => {
    const root = fixture(context);
    mkdirSync(join(root, '.config'));
    symlinkSync(join(root, '.config'), join(root, 'visible'));
    expect(() => checkRoot(join(root, 'visible'))).toThrow(/начинается с точки/);
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

  test('a file with a Cyrillic name is read', (context) => {
    const root = fixture(context);
    mkdirSync(join(root, 'Манускрипты'));
    writeFileSync(join(root, 'Манускрипты/Младшая Звезда.md'), 'текст');
    expect(readSource(root, 'Манускрипты/Младшая Звезда.md').content.toString('utf8')).toBe('текст');
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

  test('the current directory is restored after success and after an error', (context) => {
    const root = fixture(context);
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir/a.txt'), 'a');
    const start = process.cwd();
    readSource(root, 'dir/a.txt');
    expect(process.cwd()).toBe(start);
    expect(() => readSource(root, 'dir/none.txt')).toThrow(/не найден/);
    expect(process.cwd()).toBe(start);
  });

  /** Replace `docs` with a link to `outside` right after the program checks `docs`. This makes the race deterministic. */
  function swapAfterCheck(context: TestContext): { root: string; swap: () => void } {
    const root = realpathSync(fixture(context));
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'docs/notes.txt'), 'selected');
    writeFileSync(join(root, 'outside/notes.txt'), 'outside');
    const swap = (): void => {
      renameSync(join(root, 'docs'), join(root, 'docs-saved'));
      symlinkSync(join(root, 'outside'), join(root, 'docs'));
    };
    return { root, swap };
  }

  /** Call `onPath` after each call of a file system function. The program code sees the change through its named import. */
  function hook(context: TestContext, name: 'lstatSync' | 'statSync' | 'realpathSync' | 'fstatSync', onPath: (path: unknown) => void): void {
    // The default export is the mutable CommonJS module. syncBuiltinESMExports copies the change to the named exports.
    const mutable = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = mutable[name];
    if (!original) throw new Error(`No fs.${name}`);
    context.onTestFinished(() => {
      mutable[name] = original;
      syncBuiltinESMExports();
    });
    mutable[name] = (path: unknown, ...rest: unknown[]) => {
      const result = original(path, ...rest);
      onPath(path);
      return result;
    };
    syncBuiltinESMExports();
  }

  test('a parent directory replaced by a link after its check stops the run', (context) => {
    const { root, swap } = swapAfterCheck(context);
    let swapped = false;
    hook(context, 'lstatSync', (path) => {
      if (!swapped && (path === 'docs' || path === join(root, 'docs'))) {
        swapped = true;
        swap();
      }
    });
    expect(() => readSources(root, [{ source: 'docs/notes.txt', target: 'docs/notes.txt' }])).toThrow(/изменился во время проверки/);
    expect(swapped).toBe(true);
  });

  test('a parent directory replaced after the step into it does not change the file', (context) => {
    const { root, swap } = swapAfterCheck(context);
    let swapped = false;
    // The swap comes after the step into `docs`, before the file opens. The next name is relative to the entered directory.
    hook(context, 'statSync', (path) => {
      if (!swapped && path === '.' && process.cwd().endsWith('/docs')) {
        swapped = true;
        swap();
      }
    });
    expect(readSource(root, 'docs/notes.txt').content.toString()).toBe('selected');
    expect(swapped).toBe(true);
  });

  /** A selected root with `config.json`, and a hidden directory with another `config.json`. */
  function rootSwap(context: TestContext): { root: string; swap: () => void } {
    const base = realpathSync(fixture(context));
    const root = join(base, 'selected');
    const hidden = join(base, '.private');
    mkdirSync(root);
    mkdirSync(hidden);
    writeFileSync(join(root, 'config.json'), 'selected');
    writeFileSync(join(root, 'second.json'), 'selected');
    writeFileSync(join(hidden, 'config.json'), 'hidden');
    writeFileSync(join(hidden, 'second.json'), 'hidden');
    const swap = (): void => {
      renameSync(root, `${root}-saved`);
      symlinkSync(hidden, root);
    };
    return { root, swap };
  }

  test('a root replaced by a link after the root check stops the run', (context) => {
    const { root, swap } = rootSwap(context);
    const rootId = directoryId(root);
    let swapped = false;
    hook(context, 'realpathSync', (path) => {
      if (!swapped && path === root) {
        swapped = true;
        swap();
      }
    });
    expect(() => readSources(root, [{ source: 'config.json', target: 'config.json' }], rootId)).toThrow(/изменился во время работы/);
    expect(swapped).toBe(true);
  });

  test('a root replaced by a link between two files stops the run', (context) => {
    const { root, swap } = rootSwap(context);
    const rootId = directoryId(root);
    let reads = 0;
    hook(context, 'fstatSync', () => {
      reads++;
      if (reads === 1) swap();
    });
    expect(() =>
      readSources(
        root,
        [
          { source: 'config.json', target: 'config.json' },
          { source: 'second.json', target: 'second.json' }
        ],
        rootId
      )
    ).toThrow(/изменился во время работы/);
    expect(reads).toBeGreaterThan(0);
  });

  test('a parent of the root replaced by a link stops the run', (context) => {
    const base = realpathSync(fixture(context));
    mkdirSync(join(base, 'parent/selected'), { recursive: true });
    mkdirSync(join(base, 'other/selected'), { recursive: true });
    writeFileSync(join(base, 'parent/selected/a.txt'), 'selected');
    writeFileSync(join(base, 'other/selected/a.txt'), 'other');
    const root = join(base, 'parent/selected');
    const rootId = directoryId(root);
    renameSync(join(base, 'parent'), join(base, 'parent-saved'));
    symlinkSync(join(base, 'other'), join(base, 'parent'));
    expect(() => readSource(root, 'a.txt', rootId)).toThrow(/изменился во время работы/);
  });

  test('a file with a private key in its contents is rejected', (context) => {
    const root = fixture(context);
    writeFileSync(join(root, 'notes.txt'), `-----BEGIN RSA ${'PRIVATE'} KEY-----\n`);
    expect(() => readSources(root, [{ source: 'notes.txt', target: 'notes.txt' }])).toThrow(/похож на секрет/);
  });
});
