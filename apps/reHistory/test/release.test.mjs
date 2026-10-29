import { test } from 'vitest';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { release, inspectArchive } from '../scripts/release.mjs';

const metadata = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
function tar(entries) {
  const chunks = [];
  for (const [name, data, type = 48, mode = name.endsWith('/cli.js') ? 0o755 : 0o644] of entries) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header[156] = type;
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rehistory-release-test-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const names = [
    'README.md',
    'SECURITY.md',
    'TERMINOLOGY.md',
    'LICENSE',
    'tsconfig.json',
    'vite.config.mjs',
    'vitest.config.mjs',
    'eslint.config.mjs',
    '.prettierrc',
    '.prettierignore',
    'src/engine.ts',
    'scripts/build.mjs',
    'test/unit.test.ts',
    ...metadata.files.filter((name) => name.endsWith('.js'))
  ];
  for (const name of names) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), 'fixture\n');
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: metadata.version, packages: { '': { version: metadata.version } } }));
  const calls = [];
  let mutateArchive;
  const npm = (args) => {
    calls.push(args);
    if (args[0] === 'pack') {
      const directory = args[args.indexOf('--pack-destination') + 1];
      t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
      const names = ['package.json', ...metadata.files];
      const entries = names.map((name) => [`package/${name}`, readFileSync(join(root, name))]);
      const data = mutateArchive ? mutateArchive(entries) : tar(entries);
      const filename = `${metadata.name}-${metadata.version}.tgz`;
      writeFileSync(join(directory, filename), data);
      return JSON.stringify([{ filename, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` }]);
    }
    return '';
  };
  return {
    root,
    calls,
    npm,
    corrupt: (fn) => {
      mutateArchive = fn;
    }
  };
}

test('release публикует только проверенный архив с фиксированным registry и без hooks', async (t) => {
  const { root, calls, npm } = fixture(t);
  let verified = false;
  const result = await release({
    root,
    npm,
    verify: async () => {
      verified = true;
    },
    log: () => {}
  });
  assert.equal(verified, true);
  assert.equal(result.published, true);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['run', 'pack', 'publish']
  );
  const publish = calls.at(-1);
  assert.equal(publish[1], result.archive);
  assert(publish.includes('--ignore-scripts'));
  assert.equal(publish[publish.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
});

test('dry-run выполняет проверку архива, но не вызывает publish', async (t) => {
  const { root, calls, npm } = fixture(t);
  let verified = false;
  const result = await release({
    root,
    dryRun: true,
    npm,
    verify: async () => {
      verified = true;
    },
    log: () => {}
  });
  assert(verified);
  assert.equal(result.published, false);
  assert(!calls.some((args) => args[0] === 'publish'));
});

test('ошибка check останавливает release до pack и publish', async (t) => {
  const { root, calls } = fixture(t);
  await assert.rejects(
    release({
      root,
      npm: (args) => {
        calls.push(args);
        throw new Error('fixture-check');
      },
      log: () => {}
    }),
    /fixture-check/
  );
  assert.equal(calls.length, 1);
});

test('ошибка проверки и изменение исходников не допускают publish', async (t) => {
  const { root, calls, npm } = fixture(t);
  await assert.rejects(
    release({
      root,
      npm,
      verify: async () => {
        throw new Error('fixture-smoke');
      },
      log: () => {}
    }),
    /fixture-smoke/
  );
  await assert.rejects(
    release({
      root,
      npm,
      verify: async () => {
        writeFileSync(join(root, 'src/engine.ts'), 'changed');
      },
      log: () => {}
    }),
    /Файлы изменились/
  );
  assert(!calls.some((args) => args[0] === 'publish'));
});

test('посторонний файл в реальном tar останавливает release до smoke и publish', async (t) => {
  const { root, calls, npm, corrupt } = fixture(t);
  corrupt((entries) => tar([...entries, ['package/.npmrc', Buffer.from('fixture-secret')]]));
  await assert.rejects(release({ root, npm, verify: async () => assert.fail('smoke'), log: () => {} }), /Неподдерживаемый элемент/);
  assert(!calls.some((args) => args[0] === 'publish'));
});

test('tar проверяет байты, дубликаты, ссылки, пути и завершающие блоки', () => {
  const data = Buffer.from('fixture');
  const expected = new Map([['LICENSE', data]]);
  assert.deepEqual(inspectArchive(tar([['package/LICENSE', data]]), expected), expected);
  for (const entries of [
    [['package/LICENSE', Buffer.from('changed')]],
    [
      ['package/LICENSE', data],
      ['package/LICENSE', data]
    ],
    [['package/LICENSE', data, 50]],
    [['package/../LICENSE', data]],
    [['package/LICENSE', data, 48, 0o600]]
  ])
    assert.throws(() => inspectArchive(tar(entries), expected));
  assert.throws(() => inspectArchive(Buffer.from('not gzip'), expected));
  const invalidHeader = gunzipSync(tar([['package/LICENSE', data]]));
  invalidHeader[0] ^= 1;
  assert.throws(() => inspectArchive(gzipSync(invalidHeader), expected), /tar-заголовок/);
  const incomplete = gunzipSync(tar([['package/LICENSE', data]])).subarray(0, -512);
  assert.throws(() => inspectArchive(gzipSync(incomplete), expected), /Неполный архив/);
  assert.throws(() => inspectArchive(gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)), expected));
});

test('publishConfig не может перенаправить публикацию или переопределить hooks', async (t) => {
  const { root, calls, npm } = fixture(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...metadata, publishConfig: { registry: 'https://example.invalid/', ignoreScripts: false } }));
  await assert.rejects(release({ root, npm, log: () => {} }), /publishConfig/);
  assert.equal(calls.length, 0);
});
