import { defineConfig } from 'vite';
import { join } from 'node:path';

/** Shared Node.js CLI build settings. Resolve paths from each application's root. */
export function nodeCliConfig({ root, namespace, modules }) {
  const source = join(root, 'src');
  return defineConfig({
    root,
    logLevel: 'silent',
    envDir: false,
    resolve: { alias: { [`@${namespace}`]: source } },
    build: {
      target: 'node24',
      minify: false,
      sourcemap: false,
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      lib: { entry: modules.map((name) => join(source, `${name}.ts`)), formats: ['es'] },
      rolldownOptions: {
        external: [/^node:/],
        output: { preserveModules: true, preserveModulesRoot: source, entryFileNames: 'src/[name].js' }
      }
    }
  });
}
