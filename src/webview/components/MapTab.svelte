<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
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
  const umapChanged = () => atlas.umapChanged();
</script>

<Section {atlas} id="data" title="Data">
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
</Section>

<Section {atlas} id="umap" title="UMAP">
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
</Section>

{#if atlas.prepared?.needsProjection}
  <Section {atlas} id="result" title="Result">
      <button class="primary" disabled={atlas.phase !== 'ready' || atlas.projection === 'running' || atlas.projection === 'done'} onclick={() => atlas.project()}>
        {atlas.projection === 'done' ? 'All rows placed' : `Place all ${formatCount(atlas.nKept)} rows`}
        {#if atlas.estimate && atlas.projection === 'stale'} (≈ {formatSeconds(atlas.estimate.seconds)}){/if}
      </button>
      {#if atlas.projection === 'running'}<button onclick={() => atlas.cancelKernel()}>Cancel</button>{/if}
      <div class="hint muted">UMAP runs on the anchors; this places every other row next to its nearest anchors.</div>
  </Section>
{/if}
