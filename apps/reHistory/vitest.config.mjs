import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import viteConfig from './vite.config.mjs';

export default defineConfig({
  envDir: false,
  resolve: viteConfig.resolve,
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
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
  }
});
