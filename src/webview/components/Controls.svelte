<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Slider from './Slider.svelte';
  import { SEQUENTIAL } from '../color/colormaps';
  import { formatCount, formatSeconds } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  let filter = $state('');
  const numeric = $derived(atlas.numericColumns);
  const shown = $derived(numeric.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase())));
  const selected = $derived(new Set(atlas.prepare.features));
  const nRows = $derived(atlas.describe?.nRows ?? 0);
  const sampledRows = $derived(Math.max(1, Math.round((nRows * atlas.prepare.samplePct) / 100)));
  const effectiveDims = $derived(atlas.prepare.pca ? Math.min(atlas.prepare.pcaDims, atlas.prepare.features.length) : atlas.prepare.features.length);
  const anchorBudgetRows = $derived(Math.floor((atlas.settings?.anchorBudget ?? 1e7) / Math.max(1, effectiveDims)));
  // Anchors: the rows UMAP runs on in the browser; the rest are placed by nearest anchors.
  const anchorMax = $derived(Math.max(1, Math.min(anchorBudgetRows, sampledRows)));
  const anchorMin = $derived(Math.min(1000, anchorMax));
  const anchorStep = $derived(anchorMax > 50_000 ? 1000 : anchorMax > 5_000 ? 100 : 10);
  const anchorValue = $derived(Math.max(anchorMin, Math.min(atlas.prepare.maxAnchors, anchorMax)));
  // From docs/benchmarks.md: ~0.73 ms per anchor on the CPU, ~0.04 ms on the GPU (200 epochs).
  const anchorSeconds = $derived((anchorValue * (atlas.useGpu ? 0.045e-3 : 0.73e-3) * atlas.umap.nEpochs) / 200);
  const wideHint = $derived(!atlas.prepare.pca && atlas.prepare.features.length > 50 && anchorBudgetRows < 20_000 && sampledRows > anchorBudgetRows);
  const busy = $derived(atlas.phase === 'preparing' || atlas.phase === 'loading');

  function toggle(i: number) {
    const s = new Set(atlas.prepare.features);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    atlas.prepare.features = [...s].sort((a, b) => a - b);
  }
  function setAll(on: boolean) {
    const ids = shown.map((c) => c.index);
    const s = new Set(atlas.prepare.features);
    for (const i of ids) on ? s.add(i) : s.delete(i);
    atlas.prepare.features = [...s].sort((a, b) => a - b);
  }
  function onColorChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setColorColumn(v === '' ? null : Number(v));
  }
  const umapChanged = () => atlas.umapChanged();
</script>

<div class="controls">
  <header>
    <h1 title={atlas.variable}>{atlas.variable}</h1>
    {#if atlas.describe}
      <div class="sub">
        {atlas.describe.frameKind} · {formatCount(atlas.describe.nRows)} rows × {formatCount(atlas.describe.nCols)} columns
      </div>
    {/if}
  </header>

  <details open>
    <summary>Data</summary>
    <div class="section">
      <details class="features">
        <summary>Features: {atlas.prepare.features.length} of {numeric.length} numeric columns</summary>
        <input class="filter" placeholder="Filter columns" bind:value={filter} />
        <div class="feature-actions">
          <button class="link" onclick={() => setAll(true)}>Select {filter ? 'matching' : 'all'}</button>
          <button class="link" onclick={() => setAll(false)}>Clear {filter ? 'matching' : 'all'}</button>
        </div>
        <div class="feature-list">
          {#each shown as c (c.index)}
            <label class="check">
              <input type="checkbox" checked={selected.has(c.index)} onchange={() => toggle(c.index)} />
              <span class="cname">{c.name}</span><span class="dtype">{c.dtype}</span>
            </label>
          {/each}
        </div>
      </details>

      <label class="slider">
        <span class="row">
          <span class="name">Sample rows</span>
          <span><input class="num" type="number" min="0.1" max="100" step="0.1" value={atlas.prepare.samplePct}
              onchange={(e) => (atlas.prepare.samplePct = Math.min(100, Math.max(0.1, Number((e.target as HTMLInputElement).value))))} /> %</span>
        </span>
        <input type="range" min="0.1" max="100" step="0.1" value={atlas.prepare.samplePct}
          oninput={(e) => (atlas.prepare.samplePct = Number((e.target as HTMLInputElement).value))} aria-label="Sample percentage" />
        <span class="fmt">{atlas.prepare.samplePct}% → {formatCount(sampledRows)} rows</span>
      </label>

      <label class="check"><input type="checkbox" bind:checked={atlas.prepare.standardize} /> Standardize columns (z-score)</label>
      <label class="check"><input type="checkbox" bind:checked={atlas.prepare.pca} /> Apply PCA first</label>
      {#if atlas.prepare.pca}
        <Slider label="PCA components" bind:value={atlas.prepare.pcaDims} min={2} max={Math.max(2, Math.min(200, atlas.prepare.features.length))} />
      {/if}
      {#if wideHint}
        <div class="hint">Wide data: only about {formatCount(anchorBudgetRows)} rows fit in the browser UMAP at {effectiveDims} dimensions. Enabling PCA allows more rows and faster placement.</div>
      {/if}
      <label class="slider" title="Anchors are the rows UMAP runs on in the browser. The other rows are placed in the kernel next to their nearest anchors. More anchors: more accurate, but slower.">
        <span class="row">
          <span class="name">Anchors</span>
          <input class="num wide" type="number" min={anchorMin} max={anchorMax} step={anchorStep} value={anchorValue}
            onchange={(e) => (atlas.prepare.maxAnchors = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || anchorMin)))} />
        </span>
        <input type="range" min={anchorMin} max={anchorMax} step={anchorStep} value={anchorValue}
          oninput={(e) => (atlas.prepare.maxAnchors = Number((e.target as HTMLInputElement).value))} aria-label="Number of anchors" />
        <span class="fmt">
          {#if anchorValue >= sampledRows}
            UMAP on all {formatCount(sampledRows)} rows
          {:else}
            UMAP on {formatCount(anchorValue)} rows, {formatCount(sampledRows - anchorValue)} placed by nearest anchors
          {/if}
          · ≈ {formatSeconds(anchorSeconds)} ({atlas.useGpu ? 'GPU' : 'CPU'})
        </span>
      </label>
      <label class="select">
        <span>Missing values</span>
        <select bind:value={atlas.prepare.nanPolicy}>
          <option value="drop">Drop rows</option>
          <option value="impute">Impute median</option>
        </select>
      </label>
      <label class="select">
        <span>Seed</span>
        <input class="num wide" type="number" bind:value={atlas.prepare.seed} />
      </label>
      <button class="primary" disabled={busy || !atlas.prepareDirty || atlas.prepare.features.length === 0} onclick={() => atlas.runPrepare()}>
        {atlas.prepareDirty ? 'Apply' : 'Applied'}
      </button>
    </div>
  </details>

  <details open>
    <summary>UMAP</summary>
    <div class="section">
      {#if atlas.describe?.deps?.umap}
        <label class="select">
          <span>Compute</span>
          <select bind:value={atlas.computeMode}>
            <option value="browser">Browser (live)</option>
            <option value="kernel">Kernel (umap-learn)</option>
          </select>
        </label>
        {#if atlas.computeMode === 'kernel'}
          <div class="hint muted">Runs umap-learn on all {formatCount(atlas.nKept)} prepared rows in the kernel. No animation; parameters apply when you click Run.</div>
        {/if}
      {/if}
      <Slider label="Neighbors" tag="rebuild" bind:value={atlas.umap.nNeighbors} min={2} max={200} onchange={umapChanged}
        hint="n_neighbors: larger values preserve more global structure. Rebuilds the neighbor graph." />
      <Slider label="Min distance" tag="live" bind:value={atlas.umap.minDist} min={0} max={1} step={0.01} onchange={umapChanged}
        hint="min_dist: how tightly points may be packed. Applied live." />
      <Slider label="Spread" tag="live" bind:value={atlas.umap.spread} min={0.5} max={3} step={0.05} onchange={umapChanged}
        hint="spread: the scale of embedded points. Applied live." />
      <Slider label="Epochs" tag="rebuild" bind:value={atlas.umap.nEpochs} min={50} max={1000} step={10} onchange={umapChanged} />
      <label class="select">
        <span>Metric <span class="tag rebuild">rebuild</span></span>
        <select bind:value={atlas.umap.metric} onchange={umapChanged}>
          <option value="euclidean">Euclidean</option>
          <option value="cosine">Cosine</option>
        </select>
      </label>
      <label class="select">
        <span>Seed <span class="tag rebuild">rebuild</span></span>
        <span class="inline">
          <input class="num wide" type="number" bind:value={atlas.umap.seed} onchange={umapChanged} />
          <button class="icon" title="Random seed" onclick={() => { atlas.umap.seed = Math.floor(Math.random() * 100000); umapChanged(); }}>⚄</button>
        </span>
      </label>
      <details>
        <summary>Advanced</summary>
        <Slider label="Repulsion strength" tag="live" bind:value={atlas.umap.repulsionStrength} min={0.1} max={5} step={0.1} onchange={umapChanged} />
        <Slider label="Negative sample rate" tag="live" bind:value={atlas.umap.negativeSampleRate} min={1} max={20} onchange={umapChanged} />
        <Slider label="Learning rate" tag="live" bind:value={atlas.umap.learningRate} min={0.1} max={4} step={0.1} onchange={umapChanged} />
      </details>
      {#if atlas.gpuAvailable && atlas.computeMode === 'browser'}
        <label class="check" title="Run UMAP on the GPU. Much faster; falls back to the CPU on errors.">
          <input type="checkbox" bind:checked={atlas.useGpu} onchange={() => atlas.startUmap()} /> Use GPU (WebGPU)
        </label>
      {/if}
      <div class="buttons">
        {#if atlas.computeMode === 'kernel'}
          <button class="primary" disabled={!atlas.prepared || atlas.phase === 'embedding'} onclick={() => atlas.runExact()}>Run in kernel</button>
          {#if atlas.phase === 'embedding'}<button onclick={() => atlas.cancelKernel()}>Cancel</button>{/if}
        {:else if atlas.paused}
          <button class="primary" title="Continue to the end of the schedule" onclick={() => atlas.resumeUmap()}>▶ Resume</button>
          <button title="Run one epoch" onclick={() => atlas.stepUmap(1)}>+1</button>
          <button title="Run ten epochs" onclick={() => atlas.stepUmap(10)}>+10</button>
          <button title="Stop here and keep this layout" onclick={() => atlas.stopUmap()}>■ Done</button>

        {:else if atlas.phase === 'embedding'}
          <button title="Pause to step through the epochs" disabled={atlas.umapProgress?.stage !== 'optimizing'} onclick={() => atlas.pauseUmap()}>❚❚ Pause</button>
          <button title="Stop here and keep this layout" onclick={() => atlas.stopUmap()}>■ Stop</button>
        {:else}
          <button disabled={!atlas.prepared} onclick={() => atlas.startUmap()}>Restart</button>
          <button disabled={!atlas.prepared} title="Start from the initial layout (epoch 0) and step through the epochs" onclick={() => atlas.startUmap(true)}>Restart paused</button>
        {/if}
      </div>
      {#if atlas.paused && atlas.computeMode === 'browser'}
        <div class="hint muted">
          Paused at epoch {atlas.umapProgress?.epoch ?? 0} of {atlas.umapProgress?.total ?? 0}.
          {#if (atlas.umapProgress?.epoch ?? 0) === 0}This is the initial layout. UMAP's schedule moves no points in epoch 0, so the first +1 changes nothing visible.{/if}
        </div>
      {/if}
    </div>
  </details>

  <details open>
    <summary>Color</summary>
    <div class="section">
      <label class="select">
        <span>Color by</span>
        <select value={atlas.colorColumn === null ? '' : String(atlas.colorColumn)} onchange={onColorChange}>
          <option value="">None</option>
          {#each atlas.describe?.columns ?? [] as c (c.index)}
            {#if c.kind !== 'other'}<option value={String(c.index)}>{c.name}</option>{/if}
          {/each}
        </select>
      </label>
      {#if atlas.colorColumn !== null && atlas.describe?.columns[atlas.colorColumn]?.kind === 'numeric'}
        <label class="check"><input type="checkbox" bind:checked={atlas.forceCategorical} onchange={() => atlas.requestColors()} /> Treat as categories</label>
      {/if}
      {#if atlas.colorMeta?.kind === 'numeric'}
        <label class="select">
          <span>Colormap</span>
          <select value={atlas.view.colormap} onchange={(e) => atlas.setView({ colormap: (e.target as HTMLSelectElement).value })}>
            {#each Object.keys(SEQUENTIAL) as name}<option value={name}>{name}</option>{/each}
          </select>
        </label>
        {#if atlas.colorRange}
          {@const m = atlas.colorMeta}
          <label class="select">
            <span>Range</span>
            <select onchange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                atlas.colorRange = v === 'full' ? [m.min ?? 0, m.max ?? 1] : [m.q02 ?? 0, m.q98 ?? 1];
                atlas.recolor();
              }}>
              <option value="robust">2nd–98th percentile</option>
              <option value="full">Min–max</option>
            </select>
          </label>
        {/if}
      {/if}
    </div>
  </details>

  <details open>
    <summary>Display</summary>
    <div class="section">
      <Slider label="Point size" bind:value={atlas.view.pointSize} min={0.5} max={20} step={0.5} tag={undefined}
        onchange={(v) => atlas.setView({ pointSize: v })} />
      <Slider label="Opacity" bind:value={atlas.view.opacity} min={0.05} max={1} step={0.05}
        onchange={(v) => atlas.setView({ opacity: v })} />
      <label class="select">
        <span>Mode</span>
        <select value={atlas.view.mode} onchange={(e) => atlas.setView({ mode: (e.target as HTMLSelectElement).value as 'points' | 'density' })}>
          <option value="points">Points</option>
          <option value="density">Density (additive)</option>
        </select>
      </label>
      <label class="select">
        <span>Background</span>
        <span class="inline">
          <input type="color" class="color" value={atlas.plotBackground()} aria-label="Plot background color"
            oninput={(e) => atlas.setView({ background: (e.target as HTMLInputElement).value })} />
          <button class="link" disabled={!atlas.view.background} title="Follow the color theme" onclick={() => atlas.setView({ background: '' })}>Theme</button>
        </span>
      </label>
      <label class="check" title={atlas.imageColumns ? `Pixel columns ${atlas.imageColumns.first} … ${atlas.imageColumns.last}` : 'No pixel columns found (numeric columns named like px0, px1, …)'}>
        <input type="checkbox" checked={atlas.view.images} disabled={!atlas.imageColumns}
          onchange={(e) => atlas.setView({ images: (e.target as HTMLInputElement).checked })} />
        Points are images
      </label>
      {#if atlas.view.images && atlas.imageColumns && atlas.imageShape}
        <label class="select">
          <span>Image width</span>
          <span class="inline">
            <input class="num" type="number" min="1" max={atlas.imageColumns.indices.length} value={atlas.imageShape[0]}
              onchange={(e) => atlas.setView({ imageWidth: Math.max(1, Number((e.target as HTMLInputElement).value) || 0) })} />
            <span class="muted-text">× {atlas.imageShape[1]}</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" checked={atlas.view.imageInvert}
            onchange={(e) => atlas.setView({ imageInvert: (e.target as HTMLInputElement).checked })} />
          Invert colors
        </label>
        <div class="hint muted">{atlas.imageColumns.indices.length.toLocaleString()} pixel columns ({atlas.imageColumns.first} … {atlas.imageColumns.last}). Hover a point to see its image.</div>
      {/if}
      <button onclick={() => atlas.fitView()}>Fit to view</button>
    </div>
  </details>

  <details open>
    <summary>Actions</summary>
    <div class="section">
      {#if atlas.prepared?.needsProjection}
        <button class="primary" disabled={atlas.phase !== 'ready' || atlas.projection === 'running' || atlas.projection === 'done'} onclick={() => atlas.project()}>
          {atlas.projection === 'done' ? 'All rows placed' : `Place all ${formatCount(atlas.nKept)} rows`}
          {#if atlas.estimate && atlas.projection === 'stale'} (≈ {formatSeconds(atlas.estimate.seconds)}){/if}
        </button>
        {#if atlas.projection === 'running'}<button onclick={() => atlas.cancelKernel()}>Cancel</button>{/if}
      {/if}
      <button disabled={atlas.phase !== 'ready'} onclick={() => atlas.addCoordinates()}>Add coordinates to DataFrame</button>
      <button disabled={!atlas.prepared} onclick={() => atlas.savePng()}>Export PNG</button>
      <button onclick={() => atlas.copyPython()}>Copy as Python (umap-learn)</button>
    </div>
  </details>
</div>
