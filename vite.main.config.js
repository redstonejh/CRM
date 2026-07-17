import { defineConfig } from 'vite';
import { builtinModules } from 'module';

export default defineConfig({
  resolve: {
    // Force CJS entry points so Vite doesn't pick up ESM "module" fields
    // that it then fails to bundle and falls back to require().
    mainFields: ['main'],
    conditions: ['node', 'require', 'default'],
  },
  // The Forge Vite plugin builds main process in SSR mode, which externalizes
  // all npm packages by default. noExternal forces ws to be inlined into the
  // bundle so the packaged app has the API change-stream client available.
  ssr: {
    noExternal: ['ws', 'pngjs'],
  },
  build: {
    rollupOptions: {
      external: ['electron', ...builtinModules, 'bufferutil', 'utf-8-validate'],
      output: { format: 'cjs', entryFileNames: 'main.js' },
    },
  },
});
