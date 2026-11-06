import { spawnSync } from 'node:child_process';
import { lstatSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dry-run')) throw new Error('Допустим только параметр --dry-run.');
if (!process.env.npm_execpath) throw new Error('Запустите через npm run release.');
const archive = `./tx-rehistory-${version}.tgz`;
const stat = lstatSync(join(root, archive));
if (!stat.isFile() || stat.nlink !== 1) throw new Error('Архив должен быть обычным файлом без ссылок.');

// Use the npm CLI that started the script, including on Windows. Publish the packed bytes.
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'publish', archive, '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--access=public', ...args], {
  cwd: root,
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
