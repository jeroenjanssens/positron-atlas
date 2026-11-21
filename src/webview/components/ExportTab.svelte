<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import { formatCount } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  // Coordinates exist for every prepared row once UMAP has run (and all rows are placed).
  const needsPlacement = $derived(!!atlas.prepared?.needsProjection && atlas.projection !== 'done');
</script>

<Section {atlas} id="export-image" title="Image">
  <button disabled={!atlas.prepared} onclick={() => atlas.savePng()} title="Save the plot as shown (points, labels, outlines) as a PNG file">Export PNG</button>
  <div class="hint muted">The plot as shown, with labels and outlines, on the plot background.</div>
</Section>

<Section {atlas} id="export-frame" title="To the DataFrame">
  <button disabled={atlas.phase !== 'ready' || needsPlacement} onclick={() => atlas.addCoordinates()}
    title="Add the map coordinates as columns umap_x and umap_y to {atlas.variable} (rows not on the map: missing)">Add coordinates (umap_x, umap_y)</button>
  {#if needsPlacement}
    <div class="hint muted">Place all rows first (Map → Result).</div>
  {/if}
  <button disabled={!atlas.selection} onclick={() => atlas.selectionToFrame()} title="Create a new DataFrame in the session with the selected rows">
    {atlas.selection ? `New DataFrame from ${formatCount(atlas.selectedCount)} selected rows` : 'New DataFrame from selection'}
  </button>
  {#if !atlas.selection}
    <div class="hint muted">Select points first, with the lasso tool or Shift-drag.</div>
  {/if}
</Section>

<Section {atlas} id="export-code" title="Code">
  <button onclick={() => atlas.copyPython()} title="Python that computes this map with umap-learn, with the current data and UMAP settings">Copy as Python (umap-learn)</button>
  <button onclick={() => atlas.copyPolarsUmap()} title="Python that computes this map with polars-umap (UMAP in Rust, inside Polars), with the current data and UMAP settings">Copy as Python (polars-umap)</button>
  <button onclick={() => atlas.copyDataMapPlot()} title="Python that draws this map with DataMapPlot, from the coordinates and the label column in the DataFrame">Copy as DataMapPlot code</button>
  <div class="hint muted">
    The DataMapPlot code uses umap_x and umap_y: add them first (above).
    {#if atlas.labels.clusters}Labels come from atlas_cluster (Annotate → Labels → Add clusters to DataFrame).{/if}
  </div>
</Section>
