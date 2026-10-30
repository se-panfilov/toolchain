import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as viteBuild } from 'vite';

import viteConfig from '../vite.config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'dist');
const runtime = ['cli', 'convert', 'media', 'plan', 'prompts'];
const expected = runtime.map((name) => `src/${name}.js`).sort();
const directories = new Set(['src']);

// Inspect every output path without following links. Unknown files need manual review.
function filesIn(directory, prefix = '') {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dist и его подкаталоги должны быть обычными каталогами.');
  const files = [];
  for (const entry of readdirSync(directory)) {
    const relative = prefix + entry;
    const path = join(directory, entry);
    const item = lstatSync(path);
    if (item.isDirectory() && directories.has(relative)) {
      files.push(...filesIn(path, `${relative}/`));
    } else {
      if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1) throw new Error(`Файл сборки должен быть обычным файлом без ссылок: ${relative}.`);
      if (!expected.includes(relative)) throw new Error(`Неизвестный файл в dist: ${relative}. Проверьте его отдельно.`);
      files.push(relative);
    }
  }
  return files.sort();
}

async function build() {
  filesIn(out);
  // Compile into an isolated directory. A failed type check must not change dist.
  const staging = mkdtempSync(join(tmpdir(), 'tx-recast-build-'));
  try {
    const require = createRequire(import.meta.url);
    // Type-check with the TypeScript 7 compiler. The `typescript` name stays on the TypeScript 6 API for typescript-eslint.
    const manifest = require.resolve('@typescript/native/package.json');
    const compiler = join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc);
    const result = spawnSync(process.execPath, [compiler, '--project', join(root, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    if (result.error) throw new Error(`Не удалось запустить TypeScript: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Компиляция не выполнена. dist не изменён.\n${result.stdout}${result.stderr}`);
    await viteBuild({ ...viteConfig, root, configFile: false, build: { ...viteConfig.build, outDir: staging } });
    const files = filesIn(staging);
    if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error('Неожиданный набор файлов сборки. Проверьте tsconfig.json.');
    // Recheck destinations after compilation. Never follow an existing output link.
    filesIn(out);
    mkdirSync(out, { recursive: true });
    for (const file of files) {
      mkdirSync(dirname(join(out, file)), { recursive: true });
      writeFileSync(join(out, file), readFileSync(join(staging, file)), { mode: file === 'src/cli.js' ? 0o755 : 0o644 });
    }
    chmodSync(join(out, 'src/cli.js'), 0o755);
    console.log('Сборка и проверка типов завершены: dist/src/cli.js');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  await build();
} catch (error) {
  console.error(`Ошибка сборки: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
