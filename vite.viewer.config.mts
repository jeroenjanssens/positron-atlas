/**
 * Vite build config for the standalone HTML viewer (X1).
 *
 * Builds src/viewer/main.ts → dist/viewer/viewer.js
 * All JS/CSS is inlined into a single self-contained ES module.
 * No UMAP worker or clustering worker is needed (layout is pre-computed).
 */
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Collect Svelte/component CSS emitted by Vite and inject it into viewer.js via a <style> tag. */
function injectViewerCss(): Plugin {
  return {
    name: 'inject-viewer-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      let css = '';
      for (const [name, asset] of Object.entries(bundle)) {
        if (asset.type === 'asset' && name.endsWith('.css')) {
          css += typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source as Uint8Array);
          delete bundle[name];
        }
      }
      if (!css) return;
      // Prepend a self-executing style injector to viewer.js so the bundle stays a single file.
      const inject = `(function(){const __s=document.createElement('style');__s.textContent=${JSON.stringify(css)};document.head.appendChild(__s);})();\n`;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.fileName === 'viewer.js') {
          chunk.code = inject + chunk.code;
        }
      }
    },
  };
}

export default defineConfig({
  root: r('./src/viewer'),
  plugins: [svelte(), injectViewerCss()],
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
