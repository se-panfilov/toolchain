import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

// Read a regular file through one file descriptor, so that the checked file is the file that is read.
// A missing file returns undefined. A link, a directory, or a file larger than the limit is an error.
export function readRegularFile(path, limit = 16 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') throw new Error(`Ожидался обычный файл без ссылки: ${path}`, { cause: error });
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Ожидался обычный файл: ${path}`);
    if (stat.size > limit) throw new Error(`Файл слишком большой: ${path}`);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}
