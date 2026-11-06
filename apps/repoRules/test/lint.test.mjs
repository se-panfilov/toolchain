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

test('runtime modules use the @repoRules alias and never import the package itself', async () => {
  expect(await rules("import './run.js';\n", 'apps/repoRules/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import 'tx-reporules';\n", 'apps/repoRules/src/cli.ts')).toContain('no-restricted-imports');
  expect(await rules("import { summary } from '@repoRules/plan';\nexport const all = summary;\n", 'apps/repoRules/src/cli.ts')).not.toContain('no-restricted-imports');
});

test('tests may use relative imports', async () => {
  expect(await rules("import './fixture.js';\n", 'apps/repoRules/test/run.test.ts')).not.toContain('no-restricted-imports');
});
