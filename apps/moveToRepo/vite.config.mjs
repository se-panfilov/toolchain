import { fileURLToPath } from 'node:url';

import { nodeCliConfig } from '../../configs/vite.config.mjs';

export default nodeCliConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  namespace: 'moveToRepo',
  modules: ['cli', 'files', 'git', 'github', 'log', 'tools']
});
