<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();
</script>

<!-- Tools that act on the plot itself. -->
<div class="plot-toolbar" role="toolbar" aria-label="Plot tools">
  <button class="tool" title="Fit to view" aria-label="Fit to view" disabled={!atlas.prepared} onclick={() => atlas.fitView()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
  </button>
  <button class="tool" title="Export PNG" aria-label="Export PNG" disabled={!atlas.prepared} onclick={() => atlas.savePng()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" /></svg>
  </button>
</div>
