import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(directory) {
  return readdirSync(join(root, directory)).map((name) => join(root, directory, name));
}

// The program opens a pull request and never merges it. A person merges it on GitHub.
// The source and the build must not contain a merge, an approval, or an automatic merge in any form.
test.each([...files('src'), ...files('dist/src')])('%s has no merge or approval command', (path) => {
  const text = readFileSync(path, 'utf8');
  expect(text).not.toMatch(/merge|--auto\b|approve/i);
});
