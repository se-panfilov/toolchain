import { fileURLToPath } from 'node:url';

import { nodeCliConfig } from '../../configs/vite.config.mjs';

export const modules = ['book', 'cli', 'flows', 'metadata', 'prompts', 'tools', 'typograf'];

const config = nodeCliConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  namespace: 'reBook',
  modules
});

// Exception for this application: the runtime dependency typograf stays an import of the installed package.
// It is not copied into dist, so the package review and the lockfile cover the code that runs.
config.build.rolldownOptions.external = [/^node:/, 'typograf'];

export default config;
