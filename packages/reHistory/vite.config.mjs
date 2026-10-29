import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./src/', import.meta.url));
const modules = ['engine', 'audit', 'export', 'demo', 'prompts', 'cli'];

export default defineConfig({
  logLevel: 'silent',
  envDir: false,
  resolve: { alias: { '@reHistory': source } },
  build: {
    target: 'node24',
    minify: false,
    sourcemap: false,
    emptyOutDir: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    lib: {
      entry: modules.map(name => fileURLToPath(new URL(`./src/${name}.ts`, import.meta.url))),
      formats: ['es'],
    },
    rolldownOptions: {
      external: [/^node:/],
      output: { preserveModules: true, preserveModulesRoot: source, entryFileNames: 'src/[name].js' },
    },
  },
});
