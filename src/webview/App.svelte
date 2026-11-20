<script lang="ts">
  import { onMount } from 'svelte';
  import { Atlas } from './atlas.svelte';
  import Controls from './components/Controls.svelte';
  import Legend from './components/Legend.svelte';
  import PixelImage from './components/PixelImage.svelte';
  import { formatCount, formatSeconds, placeTooltip } from './logic';

  const atlas = new Atlas();
  // Exposed for end-to-end tests (test/e2e).
  (window as any).__atlas = atlas;
  let plot: HTMLDivElement;
  let mainW = $state(0);
  let mainH = $state(0);
  let ttW = $state(0);
  let ttH = $state(0);
  // Keep the tooltip inside the plot: flip to the other side of the cursor near the edges.
  const ttPos = $derived.by(() => {
    const t = atlas.tooltip;
    if (!t) return { left: 0, top: 0 };
    return { left: placeTooltip(t.x, ttW, mainW), top: placeTooltip(t.y, ttH, mainH - 24) };
  });
  let collapsed = $state(false);

  onMount(() => {
    atlas.attach(plot);
    return () => atlas.destroy();
  });

  // Persist settings (debounced) so the tab can be restored.
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    JSON.stringify([atlas.prepare, atlas.umap, atlas.view, atlas.colorColumn]);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => atlas.variable && atlas.persist(), 400);
  });

  const statusText = $derived.by(() => {
    if (atlas.phase === 'loading') return 'Connecting to the kernel…';
    if (atlas.phase === 'preparing') {
      const s = atlas.kernelStatus;
      return s?.message || `Preparing data… ${Math.round((s?.progress ?? 0) * 100)}%`;
    }
    if (atlas.phase === 'embedding' && atlas.umapProgress) {
      const u = atlas.umapProgress;
      return u.stage === 'optimizing' ? `Optimizing layout: epoch ${u.epoch}/${u.total}` : `Building neighbor graph (${u.stage}) ${Math.round(u.progress * 100)}%`;
    }
    if (atlas.projection === 'running') return atlas.kernelStatus?.message || `Placing rows… ${Math.round(atlas.projectProgress * 100)}%`;
    return '';
  });
  const progress = $derived.by(() => {
    if (atlas.phase === 'preparing') return atlas.kernelStatus?.progress ?? 0;
    if (atlas.phase === 'embedding' && atlas.umapProgress) {
      const u = atlas.umapProgress;
      return u.stage === 'optimizing' ? u.epoch / Math.max(1, u.total) : u.progress;
    }
    if (atlas.projection === 'running') return atlas.projectProgress;
    return null;
  });
  const summary = $derived.by(() => {
    const p = atlas.prepared;
    if (!p) return '';
    const parts = [`${formatCount(p.nKept)} rows`];
    if (p.nSampled < p.nRows) parts.push(`sampled from ${formatCount(p.nRows)}`);
    if (p.nDropped) parts.push(`${formatCount(p.nDropped)} dropped (missing)`);
    parts.push(`${p.dims} dims${p.explainedVariance ? ` (PCA, ${(p.explainedVariance.reduce((a, b) => a + b, 0) * 100).toFixed(1)}% variance)` : ''}`);
    if (p.needsProjection) {
      parts.push(`UMAP on ${formatCount(p.nAnchors)} anchors${atlas.projection === 'done' ? ', all rows placed' : ''}`);
    }
    const t = atlas.timings;
    const times = [
      t.umap && `UMAP ${formatSeconds(t.umap)}${atlas.computeMode === 'kernel' ? ' (umap-learn)' : atlas.useGpu ? ' (GPU)' : ' (CPU)'}`,
      t.update && `update ${formatSeconds(t.update)}`,
      t.project && `placement ${formatSeconds(t.project)}`,
    ].filter(Boolean);
    if (times.length) parts.push(times.join(', '));
    return parts.join(' · ');
  });
</script>

<div class="app" class:collapsed>
  <aside>
    {#if !collapsed}<Controls {atlas} />{/if}
  </aside>
  <main bind:clientWidth={mainW} bind:clientHeight={mainH}>
    <button class="collapse" title={collapsed ? 'Show controls' : 'Hide controls'} onclick={() => (collapsed = !collapsed)}>{collapsed ? '›' : '‹'}</button>
    <div class="plot" bind:this={plot} style:background={atlas.view.background || null}></div>
    <Legend {atlas} />
    {#if atlas.tooltip}
      <div class="tooltip" bind:clientWidth={ttW} bind:clientHeight={ttH} style="left:{ttPos.left}px; top:{ttPos.top}px">
        <div class="tt-title">Row {formatCount(atlas.tooltip.row)}</div>
        {#if atlas.tooltip.image && atlas.imageShape}
          <PixelImage values={atlas.tooltip.image} width={atlas.imageShape[0]} height={atlas.imageShape[1]} invert={atlas.view.imageInvert} />
        {/if}
        <table>
          <tbody>
            {#each atlas.tooltip.values.slice(0, 16) as [k, v]}
              <tr><th>{k}</th><td>{v}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if atlas.tooltip.values.length > 16}<div class="more">+ {atlas.tooltip.values.length - 16} more columns</div>{/if}
      </div>
    {/if}
    {#if atlas.phase === 'loading' || (atlas.phase === 'preparing' && !atlas.prepared)}
      <div class="center-msg">{statusText}</div>
    {/if}
    {#if atlas.error}
      <div class="banner" role="alert">
        <span>{atlas.error.message}</span>
        {#if atlas.error.detail}<details><summary>Details</summary><pre>{atlas.error.detail}</pre></details>{/if}
        <span class="banner-actions">
          <button onclick={() => atlas.reload()}>Reload</button>
          {#if !atlas.error.fatal}<button onclick={() => (atlas.error = null)}>Dismiss</button>{/if}
        </span>
      </div>
    {/if}
    {#if atlas.toast}<div class="toast">{atlas.toast}</div>{/if}
    <footer>
      {#if progress !== null}
        <div class="progress"><div class="bar" style="width:{Math.round(progress * 100)}%"></div></div>
      {/if}
      <span class="status">{statusText}</span>
      <span class="summary">{summary}</span>
    </footer>
  </main>
</div>
