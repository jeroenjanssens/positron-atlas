<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
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
  const anchorMax = $derived(Math.max(1, Math.min(anchorBudgetRows, sampledRows)));
  const anchorMin = $derived(Math.min(1000, anchorMax));
  const anchorStep = $derived(anchorMax > 50_000 ? 1000 : anchorMax > 5_000 ? 100 : 10);
  const anchorValue = $derived(Math.max(anchorMin, Math.min(atlas.prepare.maxAnchors, anchorMax)));
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
      <summary>Features: {atlas.prepare.features.length} of {numeric.length} numeric columns <Info id="data.features" /></summary>
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
        <span class="name">Sample rows <Info id="data.samplePct" /></span>
        <span><input class="num" type="number" min="0.1" max="100" step="0.1" value={atlas.prepare.samplePct}
            onchange={(e) => (atlas.prepare.samplePct = Math.min(100, Math.max(0.1, Number((e.target as HTMLInputElement).value))))} /> %</span>
      </span>
      <input type="range" min="0.1" max="100" step="0.1" value={atlas.prepare.samplePct}
        oninput={(e) => (atlas.prepare.samplePct = Number((e.target as HTMLInputElement).value))} aria-label="Sample percentage" />
      <span class="fmt">{atlas.prepare.samplePct}% → {formatCount(sampledRows)} rows</span>
    </label>

    <Checkbox bind:checked={atlas.prepare.standardize}>
      Standardize columns (z-score) <Info id="data.standardize" />
    </Checkbox>
    <Checkbox bind:checked={atlas.prepare.pca}>
      Apply PCA first <Info id="data.pca" />
    </Checkbox>
    {#if atlas.prepare.pca}
      <Slider label="PCA components" bind:value={atlas.prepare.pcaDims} min={2} max={Math.max(2, Math.min(200, atlas.prepare.features.length))} infoId="data.pcaDims" />
    {/if}
    {#if wideHint}
      <div class="hint">Wide data: only about {formatCount(anchorBudgetRows)} rows fit in the browser UMAP at {effectiveDims} dimensions. Enabling PCA allows more rows and faster placement.</div>
    {/if}
    <label class="slider">
      <span class="row">
        <span class="name">Anchors <Info id="data.anchors" /></span>
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
    <div class="select">
      <span>Missing values <Info id="data.missingValues" /></span>
      <Select value={atlas.prepare.nanPolicy} ariaLabel="Missing values" onchange={(e) => (atlas.prepare.nanPolicy = (e.target as HTMLSelectElement).value as 'drop' | 'impute')}>
        <option value="drop">Drop rows</option>
        <option value="impute">Impute median</option>
      </Select>
    </div>
    <label class="select">
      <span>Data seed <Info id="data.seed" /></span>
      <input class="num wide" type="number" bind:value={atlas.prepare.seed} />
    </label>
    <div class="btn-row">
      <button class="primary" disabled={busy || !atlas.prepareDirty || atlas.prepare.features.length === 0} onclick={() => atlas.runPrepare()}>
        {atlas.prepareDirty ? 'Apply' : 'Applied'}
      </button>
      <Info id="data.apply" />
    </div>
</Section>

<Section {atlas} id="umap" title="UMAP">
    {#if atlas.describe?.deps?.umap || atlas.describe?.deps?.polars_umap}
      <div class="select">
        <span>Compute <Info id="umap.computeMode" /></span>
        <Select value={atlas.computeMode} ariaLabel="Compute"
          onchange={(e) => { atlas.computeMode = (e.target as HTMLSelectElement).value as 'browser' | 'polars-umap' | 'umap-learn' | 'kernel-anchors'; }}>
          <option value="browser">Browser (live)</option>
          {#if atlas.describe?.deps?.polars_umap}<option value="polars-umap">Kernel (polars-umap)</option>{/if}
          {#if atlas.describe?.deps?.umap}<option value="umap-learn">Kernel (umap-learn)</option>{/if}
          {#if !atlas.gpuAvailable && atlas.describe?.deps?.polars_umap}
            <option value="kernel-anchors">Kernel (polars-umap) on anchors</option>
          {/if}
        </Select>
      </div>
      {#if atlas.computeMode !== 'browser' && atlas.computeMode !== 'kernel-anchors'}
        <div class="hint muted">Runs {atlas.computeMode} on all {formatCount(atlas.nKept)} prepared rows in the kernel. No animation; parameters apply when you click Run.</div>
      {:else if atlas.computeMode === 'kernel-anchors'}
        <div class="hint muted">polars-umap lays out {formatCount(atlas.nAnchors)} anchors in the kernel; placement uses the neighbour cache. No animation; available when WebGPU is absent.</div>
      {/if}
    {/if}
    <!-- T2: 2D/3D dimensions toggle (rebuild) -->
    <div class="select">
      <span>Dimensions <span class="tag rebuild">rebuild</span> <Info id="umap.dims" /></span>
      <Select value={String(atlas.dims)} ariaLabel="Dimensions"
        onchange={(e) => atlas.setDims(Number((e.target as HTMLSelectElement).value) as 2 | 3)}>
        <option value="2">2D</option>
        <option value="3">3D</option>
      </Select>
    </div>
    <Slider label="Neighbors" tag="rebuild" bind:value={atlas.umap.nNeighbors} min={2} max={200} onchange={umapChanged}
      hint="n_neighbors: larger values preserve more global structure. Rebuilds the neighbor graph." infoId="umap.nNeighbors" />
    <Slider label="Min distance" tag="live" bind:value={atlas.umap.minDist} min={0} max={1} step={0.01} onchange={umapChanged}
      hint="min_dist: how tightly points may be packed. Applied live." infoId="umap.minDist" />
    <Slider label="Spread" tag="live" bind:value={atlas.umap.spread} min={0.5} max={3} step={0.05} onchange={umapChanged}
      hint="spread: the scale of embedded points. Applied live." infoId="umap.spread" />
    <Slider label="Epochs" tag="rebuild" bind:value={atlas.umap.nEpochs} min={50} max={1000} step={10} onchange={umapChanged} infoId="umap.nEpochs" />
    <div class="select">
      <span>Metric <span class="tag rebuild">rebuild</span> <Info id="umap.metric" /></span>
      <Select value={atlas.umap.metric} ariaLabel="Metric" onchange={(e) => { atlas.umap.metric = (e.target as HTMLSelectElement).value as 'euclidean' | 'cosine'; umapChanged(); }}>
        <option value="euclidean">Euclidean</option>
        <option value="cosine">Cosine</option>
      </Select>
    </div>
    <label class="select">
      <span>UMAP seed <span class="tag rebuild">rebuild</span> <Info id="umap.seed" /></span>
      <span class="inline">
        <input class="num wide" type="number" bind:value={atlas.umap.seed} onchange={umapChanged} />
        <button class="icon" title="Random seed" onclick={() => { atlas.umap.seed = Math.floor(Math.random() * 100000); umapChanged(); }}>⚄</button>
      </span>
    </label>
    <details>
      <summary>Advanced</summary>
      <Slider label="Repulsion strength" tag="live" bind:value={atlas.umap.repulsionStrength} min={0.1} max={5} step={0.1} onchange={umapChanged} infoId="umap.repulsionStrength" />
      <Slider label="Negative sample rate" tag="live" bind:value={atlas.umap.negativeSampleRate} min={1} max={20} onchange={umapChanged} infoId="umap.negativeSampleRate" />
      <Slider label="Learning rate" tag="live" bind:value={atlas.umap.learningRate} min={0.1} max={4} step={0.1} onchange={umapChanged} infoId="umap.learningRate" />
    </details>
    {#if atlas.gpuAvailable && atlas.computeMode === 'browser'}
      <Checkbox bind:checked={atlas.useGpu} onchange={() => atlas.startUmap()}>
        Use GPU (WebGPU) <Info id="umap.useGpu" />
      </Checkbox>
    {/if}
    <div class="buttons">
      {#if atlas.computeMode === 'kernel-anchors'}
        <button class="primary" disabled={!atlas.prepared || atlas.phase === 'embedding'} onclick={() => atlas.runKernelAnchors()}>Run in kernel (anchors)</button>
        {#if atlas.phase === 'embedding'}<button onclick={() => atlas.cancelKernel()}>Cancel</button>{/if}
      {:else if atlas.computeMode !== 'browser'}
        <button class="primary" disabled={!atlas.prepared || atlas.phase === 'embedding'} onclick={() => atlas.runExact()}>Run in kernel</button>
        {#if atlas.phase === 'embedding'}<button onclick={() => atlas.cancelKernel()}>Cancel</button>{/if}
      {:else if atlas.paused}
        <button class="primary" title="Continue to the end of the schedule" onclick={() => atlas.resumeUmap()}>▶ Resume</button>
        <Info id="umap.resume" />
        <button title="Run one epoch" onclick={() => atlas.stepUmap(1)}>+1</button>
        <Info id="umap.step" />
        <button title="Run ten epochs" onclick={() => atlas.stepUmap(10)}>+10</button>
        <button title="Stop here and keep this layout" onclick={() => atlas.stopUmap()}>■ Done</button>
        <Info id="umap.stop" />
      {:else if atlas.phase === 'embedding'}
        <button title="Pause to step through the epochs" disabled={atlas.umapProgress?.stage !== 'optimizing'} onclick={() => atlas.pauseUmap()}>❚❚ Pause</button>
        <Info id="umap.pause" />
        <button title="Stop here and keep this layout" onclick={() => atlas.stopUmap()}>■ Stop</button>
      {:else}
        <button disabled={!atlas.prepared} onclick={() => atlas.startUmap()}>Restart</button>
        <Info id="umap.restart" />
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
      <div class="btn-row">
        <button class="primary" disabled={atlas.phase !== 'ready' || atlas.projection === 'running' || atlas.projection === 'done'} onclick={() => atlas.project()}>
          {atlas.projection === 'done' ? 'All rows placed' : `Place all ${formatCount(atlas.nKept)} rows`}
          {#if atlas.estimate && atlas.projection === 'stale'} (≈ {formatSeconds(atlas.estimate.seconds)}){/if}
        </button>
        <Info id="result.placeAll" />
        {#if atlas.estimate && atlas.projection === 'stale'}<Info id="result.estimate" />{/if}
      </div>
      {#if atlas.projection === 'running'}<button onclick={() => atlas.cancelKernel()}>Cancel</button>{/if}
      <div class="hint muted">UMAP runs on the anchors; this places every other row next to its nearest anchors.</div>
  </Section>
{/if}
