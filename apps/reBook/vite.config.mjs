import { fileURLToPath } from 'node:url';

import { nodeCliConfig } from '../../configs/vite.config.mjs';

export default nodeCliConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  namespace: 'reBook',
  modules: ['book', 'cli', 'flows', 'metadata', 'prompts', 'tools']
});
