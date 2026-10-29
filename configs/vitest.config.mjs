import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

const defaults = {
  environment: 'node',
  fileParallelism: true,
  maxWorkers: Math.min(3, availableParallelism()),
  isolate: true,
  sequence: { concurrent: false },
  pool: 'forks',
  testTimeout: 60000,
  hookTimeout: 60000,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true
};

export function nodeTestConfig({ root, resolve }) {
  return defineConfig({ root, envDir: false, resolve, test: { ...defaults, include: ['test/**/*.test.ts', 'test/**/*.test.mjs'] } });
}

export default defineConfig({ envDir: false, test: { ...defaults, projects: ['apps/*'] } });
