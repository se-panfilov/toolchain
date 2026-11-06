import { fileURLToPath } from 'node:url';

import { nodeCliConfig } from '../../configs/vite.config.mjs';

export const modules = [
  'access',
  'actions',
  'auth',
  'cli',
  'codeowners',
  'crypto',
  'environments',
  'execute',
  'extras',
  'flow',
  'github',
  'integrations',
  'plan',
  'prompts',
  'protection',
  'repo',
  'rulesets',
  'run',
  'secrets',
  'security',
  'settings',
  'state',
  'ui',
  'variables'
];

const config = nodeCliConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  namespace: 'reRules',
  modules
});

// Exception for this application: the runtime dependency libsodium-wrappers stays an import of the installed package.
// It is not copied into dist, so the package review and the lockfile cover the code that runs.
config.build.rolldownOptions.external = [/^node:/, 'libsodium-wrappers'];

export default config;
