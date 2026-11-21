<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();
</script>

<!-- Tools that act on the plot itself. -->
<div class="plot-toolbar" role="toolbar" aria-label="Plot tools">
  <button class="tool" class:active={atlas.tool === 'pan'} aria-pressed={atlas.tool === 'pan'} aria-label="Pan and zoom"
    title="Pan and zoom: drag to pan, scroll to zoom, hover for details. Hold Shift (add) or Alt (remove) and drag to select."
    onclick={() => (atlas.tool = 'pan')}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M8 1.5 6.3 3.2M8 1.5l1.7 1.7M8 14.5l-1.7-1.7M8 14.5l1.7-1.7M1.5 8l1.7-1.7M1.5 8l1.7 1.7M14.5 8l-1.7-1.7M14.5 8l-1.7 1.7" /></svg>
  </button>
  <button class="tool" class:active={atlas.tool === 'lasso'} aria-pressed={atlas.tool === 'lasso'} aria-label="Lasso select"
    title="Lasso select: drag around points to select them. Shift adds to the selection, Alt removes, Escape clears."
    disabled={!atlas.prepared} onclick={() => (atlas.tool = atlas.tool === 'lasso' ? 'pan' : 'lasso')}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5c3.6 0 6 1.6 6 3.6s-2.4 3.6-6 3.6-6-1.6-6-3.6 2.4-3.6 6-3.6Z" stroke-dasharray="2 1.6" /><path d="M4.2 9.1c-.6.9-.5 2.1.4 2.6.9.5 1.4 1.4 1 2.4" /></svg>
  </button>
  <span class="sep" aria-hidden="true"></span>
  <button class="tool" title="Fit to view" aria-label="Fit to view" disabled={!atlas.prepared} onclick={() => atlas.fitView()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
  </button>
  <button class="tool" title="Export PNG" aria-label="Export PNG" disabled={!atlas.prepared} onclick={() => atlas.savePng()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" /></svg>
  </button>
</div>
