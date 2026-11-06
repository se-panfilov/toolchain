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

test('runtime modules use the @reCast alias and never import the package itself', async () => {
  expect(await rules("import './plan.js';\n", 'apps/reCast/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import 'tx-recast';\n", 'apps/reCast/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import { modes } from '@reCast/plan';\nexport const all = modes;\n", 'apps/reCast/src/cli.ts')).not.toContain('no-restricted-imports');
});

test('tests may use relative imports', async () => {
  expect(await rules("import './fixture.js';\n", 'apps/reCast/test/plan.test.ts')).not.toContain('no-restricted-imports');
});
