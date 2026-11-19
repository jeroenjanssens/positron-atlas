import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/webview'),
  plugins: [svelte()],
  resolve: {
    alias: {
      // Import only the UMAP part of embedding-atlas (its package exports hide this entry).
      'embedding-atlas-umap': r('./node_modules/embedding-atlas/dist/umap.js'),
    },
  },
  worker: { format: 'es' },
  build: {
    outDir: r('./dist/webview'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 8192,
    assetsInlineLimit: 100_000_000,
    lib: {
      entry: r('./src/webview/main.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
      cssFileName: 'main',
    },
    rollupOptions: { output: { codeSplitting: false } as any },
  },
  test: {
    root: r('.'),
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
} as any);
