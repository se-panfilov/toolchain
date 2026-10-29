import { fileURLToPath } from 'node:url';

import { nodeCliConfig } from '../../configs/vite.config.mjs';

export default nodeCliConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  namespace: 'reHistory',
  modules: ['engine', 'audit', 'export', 'demo', 'prompts', 'cli', 'remote']
});
