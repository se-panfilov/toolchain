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

test('runtime modules use the @moveToRepo alias and never import the package itself', async () => {
  expect(await rules("import './files.js';\n", 'apps/moveToRepo/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import 'tx-movetorepo';\n", 'apps/moveToRepo/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import { maxFiles } from '@moveToRepo/files';\nexport const limit = maxFiles;\n", 'apps/moveToRepo/src/cli.ts')).not.toContain('no-restricted-imports');
});

test('runtime modules cannot import another application', async () => {
  expect(await rules("import { modes } from '@reCast/plan';\nexport const all = modes;\n", 'apps/moveToRepo/src/cli.ts')).toContain('no-restricted-imports');
});
