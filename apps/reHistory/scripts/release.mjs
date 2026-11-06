import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const safe = (value) => String(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? '\n' : ''));
const registry = 'https://registry.npmjs.org/';
const runtime = ['cli', 'engine', 'audit', 'export', 'demo', 'prompts', 'remote'].map((name) => `dist/src/${name}.js`);
const files = ['package.json', 'README.md', 'SECURITY.md', 'TERMINOLOGY.md', 'LICENSE', ...runtime];
const inputs = [
  'package.json',
  'package-lock.json',
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
  'src',
  'scripts',
  'test'
];

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw new Error(`Не удалось запустить команду: ${result.error.message}`);
  if (result.status !== 0) throw new Error('Команда завершилась с ошибкой. Следующие шаги не выполнены.');
  return result.stdout ?? '';
}
function runNpm(args, options) {
  const cli = process.env.npm_execpath;
  if (!cli || !isAbsolute(cli) || !lstatSync(realpathSync(cli)).isFile()) throw new Error('Запустите команду через npm run release или npm run release:dry-run.');
  return execute(process.execPath, [realpathSync(cli), ...args], options);
}
function snapshot(root, names) {
  const result = new Map();
  function visit(name) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Символическая ссылка не допускается при подготовке публикации: ${name}`);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(`${name}/${child}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Нужен обычный файл без жёстких ссылок: ${name}`);
      result.set(name, readFileSync(path));
    }
  }
  for (const name of names) visit(name);
  return result;
}
function unchanged(root, original, names) {
  const current = snapshot(root, names);
  if (current.size !== original.size || [...original].some(([name, data]) => !current.get(name)?.equals(data))) throw new Error('Файлы изменились после начала проверок. Запустите release заново.');
}

/** Accept only the expected regular tar members and compare their actual bytes. */
export function inspectArchive(compressed, expected) {
  const tar = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const string = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const octal = (start, end) => {
      const value = string(start, end).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error('Некорректное число в tar-заголовке.');
      return Number.parseInt(value, 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(148, 156) !== checksum) throw new Error('Повреждён tar-заголовок.');
    const name = string(0, 100);
    const relative = name.slice('package/'.length);
    const size = octal(124, 136);
    const mode = octal(100, 108);
    if (!name.startsWith('package/') || string(345, 500) || ![0, 48].includes(header[156]) || !expected.has(relative) || entries.has(relative))
      throw new Error(`Неподдерживаемый элемент архива: ${name}`);
    const end = offset + 512 + size;
    const data = tar.subarray(offset + 512, end);
    if (end > tar.length || !data.equals(expected.get(relative))) throw new Error(`Содержимое архива не совпадает со сборкой: ${name}`);
    if (mode !== (relative === 'dist/src/cli.js' ? 0o755 : 0o644)) throw new Error(`Неверные права файла в архиве: ${name}`);
    entries.set(relative, data);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.size !== expected.size || tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error('Неполный архив или посторонние данные после tar.');
  return entries;
}

async function smoke({ archive, directory, npm, env }) {
  const caller = join(directory, 'caller');
  mkdirSync(caller);
  const options = { cwd: caller, env, capture: true };
  const help = npm(['exec', '--offline', '--yes', '--ignore-scripts', '--cache', join(directory, 'cache'), '--package', archive, '--', 'tx-rehistory', '--help'], options);
  if (!help.includes('--audit') || !help.includes('--verify-export')) throw new Error('Проверка установленной команды не пройдена.');
  // Check read-only operation outside both the source tree and the extracted package.
  const engine = await import(pathToFileURL(join(directory, 'extracted', 'dist/src/engine.js')).href);
  engine.runGit(caller, ['init', '-q', '--template=', '-b', 'main']);
  engine.runGit(caller, ['config', 'user.name', 'Release fixture']);
  engine.runGit(caller, ['config', 'user.email', 'release@example.org']);
  engine.runGit(caller, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
  const before = snapshot(caller, ['.git']);
  const output = npm(['exec', '--offline', '--yes', '--ignore-scripts', '--cache', join(directory, 'cache'), '--package', archive, '--', 'tx-rehistory', '--audit', '--json'], options);
  if (JSON.parse(output).complete !== true) throw new Error('Аудит из установленного архива не пройден.');
  unchanged(caller, before, ['.git']);
}

/** Publish only the checked archive. Dependencies are injectable for offline failure tests. */
export async function release({ root = packageRoot, dryRun = false, npm = runNpm, verify = smoke, log = (value) => console.log(safe(value)) } = {}) {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (metadata.name !== 'tx-rehistory' || !/^\d+\.\d+\.\d+$/.test(metadata.version) || metadata.private || metadata.bin?.['tx-rehistory'] !== 'dist/src/cli.js')
    throw new Error('Проверьте имя, стабильную версию, private и bin пакета.');
  if (lock.version !== metadata.version || lock.packages?.['']?.version !== metadata.version) throw new Error('Версии package.json и package-lock.json различаются.');
  if (metadata.publishConfig !== undefined) throw new Error('publishConfig требует отдельной проверки перед публикацией через release.');
  if (
    ['dependencies', 'optionalDependencies', 'peerDependencies'].some((field) => Object.keys(metadata[field] ?? {}).length) ||
    metadata.bundleDependencies ||
    metadata.bundledDependencies ||
    ['preinstall', 'install', 'postinstall'].some((name) => metadata.scripts?.[name])
  )
    throw new Error('Публикация пакета с runtime-зависимостями или install hooks требует отдельной проверки.');
  const original = snapshot(root, inputs);
  log(`Проверка ${metadata.name}@${metadata.version}…`);
  npm(['run', 'check'], { cwd: root });
  unchanged(root, original, inputs);
  const expected = snapshot(root, files);
  const directory = mkdtempSync(join(tmpdir(), 'tx-rehistory-release-'));
  const archive = join(directory, `${metadata.name}-${metadata.version}.tgz`);
  let attemptedPublish = false;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('NPM_CONFIG_')));
    for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(directory, name), '', { flag: 'wx', mode: 0o600 });
    Object.assign(env, {
      NPM_CONFIG_USERCONFIG: join(directory, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(directory, 'global.npmrc'),
      NPM_CONFIG_CACHE: join(directory, 'cache'),
      NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_MIN_RELEASE_AGE: '7'
    });
    const report = JSON.parse(npm(['pack', root, '--ignore-scripts', '--offline', '--dry-run=false', '--json', '--pack-destination', directory], { cwd: directory, env, capture: true }));
    if (report.length !== 1 || report[0].filename !== `${metadata.name}-${metadata.version}.tgz`) throw new Error('Неожиданный результат npm pack.');
    const stat = lstatSync(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('Неподдерживаемый файл npm-архива.');
    const compressed = readFileSync(archive);
    const integrity = `sha512-${createHash('sha512').update(compressed).digest('base64')}`;
    if (integrity !== report[0].integrity) throw new Error('Контрольная сумма npm-архива не совпала.');
    const entries = inspectArchive(compressed, expected);
    const extracted = join(directory, 'extracted');
    for (const [name, data] of entries) {
      const destination = join(extracted, name);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, data, { flag: 'wx', mode: name === 'dist/src/cli.js' ? 0o755 : 0o644 });
      chmodSync(destination, name === 'dist/src/cli.js' ? 0o755 : 0o644);
    }
    await verify({ archive, directory, npm, env });
    unchanged(root, original, inputs);
    unchanged(root, expected, files);
    if (!readFileSync(archive).equals(compressed)) throw new Error('Архив изменился после проверки.');
    log(`Архив проверен: ${archive}\n${integrity}`);
    if (dryRun) log('Dry-run: публикация не выполнялась.');
    else {
      attemptedPublish = true;
      npm(['publish', archive, '--ignore-scripts', '--registry', registry, '--access', 'public', '--tag', 'latest'], { cwd: root });
      log(`Опубликован ${metadata.name}@${metadata.version}.`);
    }
    return { archive, integrity, published: !dryRun };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nАртефакты: ${directory}${attemptedPublish ? '\nПроверьте реестр перед повтором: результат публикации может быть неизвестен.' : '\nПубликация не запускалась.'}`,
      { cause: error }
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('Допустим только параметр --dry-run.');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 12)) throw new Error('Нужен Node.js 24.12 или новее.');
    const configuredDryRun = Object.entries(process.env).some(([key, value]) => key.toLowerCase() === 'npm_config_dry_run' && /^(true|1)$/i.test(value ?? ''));
    await release({ dryRun: process.argv.includes('--dry-run') || configuredDryRun });
  } catch (error) {
    console.error(safe(`Ошибка: ${error instanceof Error ? error.message : error}`));
    process.exitCode = 1;
  }
}
