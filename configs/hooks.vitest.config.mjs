import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  envDir: false,
  test: { environment: 'node', include: ['tests/hooks/**/*.test.mjs'], pool: 'forks', maxWorkers: 1, testTimeout: 30000 }
});
