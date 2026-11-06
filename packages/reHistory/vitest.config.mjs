import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config.mjs';

export default defineConfig({
  envDir: false,
  resolve: viteConfig.resolve,
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
    testTimeout: 60000,
    hookTimeout: 60000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
