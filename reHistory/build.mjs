import { stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Только собственные модули из фиксированного списка. npm не запускает TypeScript
// из node_modules; пакет получает обычный JavaScript без runtime-зависимостей.
const root = fileURLToPath(new URL('.', import.meta.url));
const out = join(root, 'dist');
try {
  if (!lstatSync(out).isDirectory() || lstatSync(out).isSymbolicLink()) throw new Error('dist должен быть обычным каталогом.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  mkdirSync(out);
}
for (const name of ['engine', 'audit', 'export', 'demo', 'cli']) {
  const destination = join(out, `${name}.js`);
  try { if (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink() || lstatSync(destination).nlink !== 1) throw new Error('Файл сборки не должен быть символической ссылкой.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = readFileSync(join(root, `${name}.ts`), 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip' }).replace(/(from\s+['"]\.\/[^'"\n]+)\.ts(['"])/g, '$1.js$2');
  writeFileSync(destination, js, { mode: name === 'cli' ? 0o755 : 0o644 });
}
chmodSync(join(out, 'cli.js'), 0o755);
console.log('Сборка готова: dist/cli.js');
