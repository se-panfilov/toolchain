import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function rules(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  expect(result.messages.filter((message) => message.fatal)).toEqual([]);
  return result.messages.map((message) => message.ruleId);
}

test('runtime modules use the @eBook alias and never import the package itself', async () => {
  expect(await rules("import './book.js';\n", 'apps/eBook/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import 'tx-ebook';\n", 'apps/eBook/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import { safe } from '@eBook/cli';\nexport const s = safe;\n", 'apps/eBook/src/cli.ts')).not.toContain('no-restricted-imports');
});

test('tests may use relative imports', async () => {
  expect(await rules("import './fixture.js';\n", 'apps/eBook/test/book.test.ts')).not.toContain('no-restricted-imports');
});
