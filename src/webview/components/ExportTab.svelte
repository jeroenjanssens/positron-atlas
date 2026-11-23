<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
  import NumberInput from './controls/NumberInput.svelte';
  import { formatCount } from '../logic';
  import type { HtmlExportOptions } from '../atlas/exportHtml';
  import { isVideoSupported } from '../render/videoExport';
  import type { VideoExportOptions } from '../../shared/protocol';

  let { atlas }: { atlas: Atlas } = $props();

  // ---- Video export state ----
  const videoAvailable = isVideoSupported();
  let videoMode = $state<'time' | 'turntable'>('time');
  let videoFps = $state(30);
  let videoDuration = $state(3);

  function doRecord() {
    const opts: VideoExportOptions = {
      mode: videoMode,
      widthPx: 1280, heightPx: 720,
      fps: videoFps,
      durationSecs: videoDuration,
    };
    atlas.startVideoExport(opts);
  }

  // Coordinates exist for every prepared row once UMAP has run (and all rows are placed).
  const needsPlacement = $derived(!!atlas.prepared?.needsProjection && atlas.projection !== 'done');

  // ---- HTML export dialog state ----
  const cols = $derived(atlas.describe?.columns ?? []);
  const textCols = $derived(cols.filter((c) => c.kind === 'categorical' || c.kind === 'other'));

  let htmlExportCols = $state<Set<number>>(new Set());
  let htmlLinkCol = $state(-1);
  let htmlMaxChars = $state(200);

  // Pre-select sensible defaults when the dialog opens.
  $effect(() => {
    if (!atlas.htmlExportOpen) return;
    const tc = atlas.tooltipOpts?.titleColumn;
    const defaults = new Set<number>();
    if (typeof tc === 'number') defaults.add(tc);
    // Add the first few text columns if fewer than 5
    for (const c of textCols.slice(0, 5)) defaults.add(c.index);
    htmlExportCols = defaults;
    // Auto-detect link column
    htmlLinkCol = atlas.tooltipOpts?.linkColumn ?? -1;
  });

  function toggleCol(idx: number) {
    const next = new Set(htmlExportCols);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    htmlExportCols = next;
  }

  function doExport() {
    const opts: HtmlExportOptions = {
      tooltipColumns: [...htmlExportCols],
      linkColumn: htmlLinkCol,
      maxChars: htmlMaxChars,
      embedImages: false,
      samplePct: 100,
    };
    atlas.exportHtml(opts);
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  const estBytes = $derived.by(() => {
    if (!atlas.htmlExportOpen || !atlas.prepared) return 0;
    return atlas.estimateExportBytes({ tooltipColumns: [...htmlExportCols], maxChars: htmlMaxChars });
  });
</script>

<Section {atlas} id="export-image" title="Image">
  <div class="btn-row">
    <button disabled={!atlas.prepared} onclick={() => atlas.savePng()} title="Save the plot as shown (points, labels, outlines) as a PNG file">Export PNG</button>
    <Info id="export.png" />
  </div>
  <div class="hint muted">The plot as shown, with labels and outlines, on the plot background.{atlas.grid.enabled ? ' In grid mode: all panels are included.' : ''}</div>
</Section>

<Section {atlas} id="export-html" title="Interactive HTML">
  <div class="btn-row">
    <button disabled={!atlas.prepared} onclick={() => { atlas.htmlExportOpen = true; }}
      title="Export the map as a self-contained HTML file that works offline in any browser">
      HTML…
    </button>
    <Info id="export.exportHtml" />
  </div>
  <div class="hint muted">Self-contained HTML with pan/zoom, hover, legend toggles, and search. Works in 2D and 3D.{atlas.grid.enabled ? ' In grid mode: the HTML viewer shows the first panel\'s colors.' : ''}</div>
</Section>

{#if atlas.htmlExportOpen}
  <!-- Modal dialog overlay -->
  <div class="html-export-backdrop" role="dialog" aria-label="HTML export options" aria-modal="true">
    <div class="html-export-dialog">
      <div class="hed-header">
        <span class="hed-title">Export as HTML</span>
        <button class="hed-close icon-btn" onclick={() => { atlas.htmlExportOpen = false; }} title="Cancel">✕</button>
      </div>

      <div class="hed-section-label">Tooltip columns</div>
      <div class="hed-cols">
        {#each textCols as c}
          <div class="hed-col-row">
            <input type="checkbox" id="hed-col-{c.index}" checked={htmlExportCols.has(c.index)} onchange={() => toggleCol(c.index)} />
            <label class="hed-col-name" for="hed-col-{c.index}">{c.name}</label>
            {#if htmlExportCols.has(c.index) && htmlLinkCol !== c.index}
              <button class="hed-link-btn" onclick={() => { htmlLinkCol = c.index; }} title="Use as link column">link</button>
            {:else if htmlLinkCol === c.index}
              <button class="hed-link-btn active" onclick={() => { htmlLinkCol = -1; }} title="Remove link column">link ✓</button>
            {/if}
          </div>
        {/each}
        {#if textCols.length === 0}
          <span class="muted hint">No text columns available.</span>
        {/if}
      </div>

      <div class="hed-row">
        <label class="hed-label" for="hed-maxchars">Max chars per cell</label>
        <input id="hed-maxchars" class="hed-num" type="number" min="20" max="2000" step="20" bind:value={htmlMaxChars} />
      </div>

      <div class="hed-size-hint muted">
        Estimated size (before gzip): {fmtBytes(estBytes)}
        {#if estBytes > 100 * 1024 * 1024}
          <span class="hed-warn">⚠ Exceeds 100 MB recommendation.</span>
        {/if}
      </div>

      <div class="hed-actions">
        <button onclick={() => { atlas.htmlExportOpen = false; }}>Cancel</button>
        <button class="primary" onclick={doExport} disabled={!atlas.prepared}>Export</button>
      </div>
    </div>
  </div>
{/if}

<Section {atlas} id="export-video" title="Video">
  {#if videoAvailable}
    <div class="select">
      <span>Recording</span>
      <Select value={videoMode} ariaLabel="Video recording" onchange={(e) => { videoMode = (e.target as HTMLSelectElement).value as 'time' | 'turntable'; }}>
        <option value="time">Time animation</option>
        <option value="turntable">3D turntable</option>
      </Select>
    </div>
    <div class="select">
      <span>Frames per second</span>
      <NumberInput bind:value={videoFps} min={10} max={60} step={5} ariaLabel="Frames per second" />
    </div>
    <div class="select">
      <span>Duration (s)</span>
      <NumberInput bind:value={videoDuration} min={1} max={60} step={1} ariaLabel="Duration in seconds" />
    </div>
    <div class="btn-row">
      <button disabled={atlas.videoRecording || (videoMode === 'time' && !atlas.animateValues)} onclick={doRecord}>
        {atlas.videoRecording ? 'Recording…' : 'Record'}
      </button>
      <Info id="export.video" />
    </div>
    {#if videoMode === 'time' && !atlas.animateValues}
      <div class="hint muted">Set Animate by a column first (Explore tab).</div>
    {/if}
    {#if videoMode === 'turntable' && atlas.dims !== 3}
      <div class="hint muted">Switch to 3D for a turntable recording.</div>
    {/if}
  {:else}
    <div class="hint muted">WebM recording is not available in this browser.</div>
  {/if}
</Section>

<Section {atlas} id="export-frame" title="To the DataFrame">
  <div class="btn-row">
    <button disabled={atlas.phase !== 'ready' || needsPlacement} onclick={() => atlas.addCoordinates()}
      title="Add the map coordinates as columns umap_x and umap_y to {atlas.variable} (rows not on the map: missing)">Add coordinates (umap_x, umap_y)</button>
    <Info id="export.addCoordinates" />
  </div>
  {#if needsPlacement}
    <div class="hint muted">Place all rows first (Map → Result).</div>
  {/if}
  <div class="btn-row">
    <button disabled={!atlas.selection} onclick={() => atlas.selectionToFrame()} title="Create a new DataFrame in the session with the selected rows">
      {atlas.selection ? `New DataFrame from ${formatCount(atlas.selectedCount)} selected rows` : 'New DataFrame from selection'}
    </button>
    <Info id="export.selectionToFrame" />
  </div>
  {#if !atlas.selection}
    <div class="hint muted">Select points first, with the lasso tool or Shift-drag.</div>
  {/if}
</Section>

<Section {atlas} id="export-code" title="Code">
  <div class="btn-row">
    <button onclick={() => atlas.copyPython()} title="Python that computes this map with umap-learn, with the current data and UMAP settings">Copy as Python (umap-learn)</button>
    <Info id="export.copyPython" />
  </div>
  <div class="btn-row">
    <button onclick={() => atlas.copyPolarsUmap()} title="Python that computes this map with polars-umap (UMAP in Rust, inside Polars), with the current data and UMAP settings">Copy as Python (polars-umap)</button>
    <Info id="export.copyPolarsUmap" />
  </div>
  <div class="btn-row">
    <button disabled={atlas.dims === 3} onclick={() => atlas.copyDataMapPlot()} title="Python that draws this map with DataMapPlot, from the coordinates and the label column in the DataFrame">Copy as DataMapPlot code</button>
    <Info id="export.copyDataMapPlot" />
  </div>
  <div class="hint muted">
    The DataMapPlot code uses umap_x and umap_y: add them first (above).
    {#if atlas.labels.clusters}Labels come from atlas_cluster (Annotate → Labels → Add clusters to DataFrame).{/if}
  </div>
</Section>

{#if atlas.describe?.deps?.datamapplot}
<Section {atlas} id="export-datamapplot" title="Interactive HTML (DataMapPlot)">
  {#if atlas.dims === 3}<div class="hint muted">Not available in 3D: switch Map → UMAP → Dimensions to 2D.</div>{/if}
  <div class="btn-row">
    <button disabled={!atlas.prepared || atlas.dims === 3} onclick={() => atlas.exportDataMapPlot()}
      title="Export the map as a self-contained interactive DataMapPlot HTML file (requires datamapplot)">
      Export with DataMapPlot…
    </button>
    <Info id="export.exportDataMapPlot" />
  </div>
  <div class="hint muted">
    Saves a self-contained HTML file using the current label column and hover text.
  </div>
</Section>
{/if}

<style>
  .html-export-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .html-export-dialog {
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    padding: 16px;
    min-width: 320px;
    max-width: 420px;
    width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    color: var(--vscode-editor-foreground, #ccc);
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  }
  .hed-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .hed-title { font-weight: 600; font-size: 1.05em; }
  .hed-close {
    background: none; border: none; cursor: pointer;
    color: var(--vscode-editor-foreground, #ccc);
    font-size: 1em; padding: 2px 6px;
  }
  .hed-section-label {
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground, #999);
    margin: 8px 0 4px;
  }
  .hed-cols {
    display: flex; flex-direction: column; gap: 2px;
    max-height: 200px; overflow-y: auto;
    margin-bottom: 10px;
  }
  .hed-col-row {
    display: flex; align-items: center; gap: 6px;
    font-size: 0.9em; cursor: pointer;
    padding: 2px 4px; border-radius: 3px;
  }
  .hed-col-row:hover { background: var(--vscode-list-hoverBackground, #333); }
  .hed-col-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hed-link-btn {
    font-size: 0.75em; padding: 1px 5px;
    background: var(--vscode-button-secondaryBackground, #3a3a3a);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-button-border, #555);
    border-radius: 3px; cursor: pointer;
  }
  .hed-link-btn.active {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .hed-row {
    display: flex; align-items: center; gap: 8px; margin: 6px 0;
  }
  .hed-label { font-size: 0.9em; flex: 1; }
  .hed-num { width: 80px; }
  .hed-size-hint { font-size: 0.82em; margin: 8px 0; }
  .hed-warn { color: var(--vscode-errorForeground, #f48771); margin-left: 4px; }
  .hed-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;
  }
</style>
