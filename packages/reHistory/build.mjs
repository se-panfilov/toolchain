import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = join(root, 'dist');
const modules = ['engine', 'audit', 'export', 'demo', 'prompts', 'cli', 'engine.test', 'features.test', 'prompts.test'];

function checkOutput() {
  try {
    const stat = lstatSync(out);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dist должен быть обычным каталогом.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of modules) {
    try {
      const stat = lstatSync(join(out, `${name}.js`));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Файл сборки должен быть обычным файлом без ссылок.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function build() {
  checkOutput();
  // Compile into an isolated directory. A failed type check must not change dist.
  const staging = mkdtempSync(join(tmpdir(), 'tx-rehistory-build-'));
  try {
    const require = createRequire(import.meta.url);
    const compiler = require.resolve('typescript/lib/tsc.js');
    const result = spawnSync(process.execPath, [compiler, '--project', join(root, 'tsconfig.json'), '--outDir', staging, '--pretty', 'false'], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw new Error(`Не удалось запустить TypeScript: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Компиляция не выполнена. dist не изменён.\n${result.stdout}${result.stderr}`);
    const expected = modules.map(name => `${name}.js`).sort();
    const files = readdirSync(staging).sort();
    if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error('Неожиданный набор файлов сборки. Проверьте tsconfig.json.');
    // Recheck destinations after compilation. Never follow an existing output link.
    checkOutput();
    mkdirSync(out, { recursive: true });
    for (const file of files) {
      writeFileSync(join(out, file), readFileSync(join(staging, file)), { mode: file === 'cli.js' ? 0o755 : 0o644 });
    }
    chmodSync(join(out, 'cli.js'), 0o755);
    console.log('Сборка и проверка типов завершены: dist/cli.js');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try { build(); }
catch (error) {
  console.error(`Ошибка сборки: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
