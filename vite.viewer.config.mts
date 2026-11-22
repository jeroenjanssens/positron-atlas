/**
 * Vite build config for the standalone HTML viewer (X1).
 *
 * Builds src/viewer/main.ts → dist/viewer/viewer.js
 * All JS/CSS is inlined into a single self-contained ES module.
 * No UMAP worker or clustering worker is needed (layout is pre-computed).
 */
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/viewer'),
  plugins: [svelte()],
  resolve: {
    alias: [
      // Reuse the same embedding-atlas alias as the webview build.
      { find: 'embedding-atlas-umap', replacement: r('./node_modules/embedding-atlas/dist/umap.js') },
      { find: /^embedding-atlas-clustering-worker(\?.*)?$/, replacement: `${r('./node_modules/embedding-atlas/dist/clustering.worker.js')}$1` },
    ],
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  worker: { format: 'es' },
  build: {
    outDir: r('./dist/viewer'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 8192,
    // Inline everything — the viewer JS must be a single self-contained file.
    assetsInlineLimit: 100_000_000,
    lib: {
      entry: r('./src/viewer/main.ts'),
      formats: ['es'],
      fileName: () => 'viewer.js',
    },
    rollupOptions: { output: { codeSplitting: false } as any },
  },
} as any);
