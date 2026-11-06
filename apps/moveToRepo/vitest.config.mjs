import { fileURLToPath } from 'node:url';

import { nodeTestConfig } from '../../configs/vitest.config.mjs';
import viteConfig from './vite.config.mjs';

export default nodeTestConfig({ root: fileURLToPath(new URL('./', import.meta.url)), resolve: viteConfig.resolve });
