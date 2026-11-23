<script lang="ts">
  import { onMount } from 'svelte';
  import { Atlas } from './atlas.svelte';
  import Controls from './components/Controls.svelte';
  import Legend from './components/Legend.svelte';
  import PlotToolbar from './components/PlotToolbar.svelte';
  import LassoLayer from './components/LassoLayer.svelte';
  import BrushLayer from './components/BrushLayer.svelte';
  import ShapeLayer from './components/ShapeLayer.svelte';
  import PixelImage from './components/PixelImage.svelte';
  import HoverCard from './components/HoverCard.svelte';
  import TitleOverlay from './components/TitleOverlay.svelte';
  import AnnotationOverlay from './components/AnnotationOverlay.svelte';
  import AroundLabelsOverlay from './components/AroundLabelsOverlay.svelte';
  import GlowOverlay from './components/GlowOverlay.svelte';
  import CheatSheet from './components/CheatSheet.svelte';
  import NavHint from './components/NavHint.svelte';
  import { formatCount, formatSeconds, placeTooltip, resolveInvert } from './logic';
  import SearchBox from './components/SearchBox.svelte';
  import { vscode } from './vscode';
  import { gridViewRects, panelCount, panelTitle, GRID_TOP_BAND_PX } from './atlas/grid';

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
    JSON.stringify([atlas.prepare, atlas.umap, atlas.view, atlas.colorColumn, atlas.ui, atlas.labels,
      atlas.tooltipOpts, atlas.hiddenCategories, atlas.loadImagesFromUrls,
      atlas.titleOverlay, atlas.annotations, atlas.annotateIdColumn, atlas.grid]);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => atlas.variable && atlas.persist(), 400);
  });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && atlas.pinnedCard) {
      atlas.closePinnedCard();
      e.preventDefault();
    }
  }

  // Track whether the webview has keyboard focus so the host can set/clear the
  // positronAtlas.webviewFocused context key (item 1).
  //
  // Rules (per spike S1):
  //   - webviewFocused = true when the VS Code panel has focus AND no text input
  //     inside the webview is active (search box, font picker, annotation editing).
  //   - webviewFocused = false on panel blur OR when a text INPUT/TEXTAREA/
  //     contentEditable within the webview receives focus.
  //
  // We track this with two layers:
  //   1. window.onfocus / window.onblur for the panel-level focus state.
  //   2. document.onfocusin / document.onfocusout to detect text-input focus.

  let panelFocused = false;
  let textInputFocused = false;

  function updateFocusContext() {
    const focused = panelFocused && !textInputFocused;
    vscode.post({ type: focused ? 'webviewFocused' : 'webviewBlurred' });
  }

  function onWindowFocus() {
    panelFocused = true;
    updateFocusContext();
  }

  function onWindowBlur() {
    panelFocused = false;
    updateFocusContext();
  }

  function onDocumentFocusIn(e: FocusEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable) {
      textInputFocused = true;
      updateFocusContext();
    }
  }

  function onDocumentFocusOut(e: FocusEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable) {
      textInputFocused = false;
      updateFocusContext();
    }
  }

  const statusText = $derived.by(() => {
    if (atlas.phase === 'loading') return 'Connecting to the kernel…';
    if (atlas.phase === 'preparing') {
      const s = atlas.kernelStatus;
      return s?.message || `Preparing data… ${Math.round((s?.progress ?? 0) * 100)}%`;
    }
    if (atlas.phase === 'embedding' && atlas.umapProgress) {
      const u = atlas.umapProgress;
      if (u.stage === 'paused') return `Paused at epoch ${u.epoch}/${u.total}`;
      return u.stage === 'optimizing' ? `Optimizing layout: epoch ${u.epoch}/${u.total}` : `Building neighbor graph (${u.stage}) ${Math.round(u.progress * 100)}%`;
    }
    if (atlas.projection === 'running') return atlas.kernelStatus?.message || `Placing rows… ${Math.round(atlas.projectProgress * 100)}%`;
    return '';
  });
  const progress = $derived.by(() => {
    if (atlas.phase === 'preparing') return atlas.kernelStatus?.progress ?? 0;
    if (atlas.phase === 'embedding' && atlas.umapProgress) {
      const u = atlas.umapProgress;
      return u.stage === 'optimizing' || u.stage === 'paused' ? u.epoch / Math.max(1, u.total) : u.progress;
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
      t.umap && `UMAP ${formatSeconds(t.umap)}${atlas.layoutEngine ? ` (${atlas.layoutEngine})` : ''}`,
      t.update && `update ${formatSeconds(t.update)}`,
      t.project && `placement ${formatSeconds(t.project)}${atlas.placementBackend === 'rust' ? ' (Rust)' : atlas.placementBackend === 'numpy' ? ' (numpy)' : ''}`,
    ].filter(Boolean);
    if (times.length) parts.push(times.join(', '));
    return parts.join(' · ');
  });
</script>

<svelte:window onkeydown={onKeyDown} onfocus={onWindowFocus} onblur={onWindowBlur} />
<svelte:document onfocusin={onDocumentFocusIn} onfocusout={onDocumentFocusOut} />

<div class="app" class:collapsed>
  <aside>
    {#if !collapsed}<Controls {atlas} />{/if}
  </aside>
  <main bind:clientWidth={mainW} bind:clientHeight={mainH}>
    <button class="collapse" title={collapsed ? 'Show controls' : 'Hide controls'} onclick={() => (collapsed = !collapsed)}>{collapsed ? '›' : '‹'}</button>
    <PlotToolbar {atlas} />
    {#if atlas.phase === 'ready'}<SearchBox {atlas} />{/if}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="plot" class:lasso={atlas.tool === 'lasso'} class:annotate={atlas.tool === 'annotate'} bind:this={plot} style:background={atlas.view.background || null}
      role="application" aria-label="Map plot"
      onclick={(e) => {
        if (atlas.tool === 'annotate') {
          // Ignore clicks that land on overlay elements (callout boxes, leader SVG, title).
          const target = e.target as HTMLElement;
          if (target.closest('.callout') || target.closest('.leader-svg') || target.closest('.title-overlay')) return;
          atlas.handleAnnotateClick();
        } else {
          atlas.onClick(e);
        }
      }}
      onkeydown={(e) => e.key === 'Enter' && (atlas.tool === 'annotate' ? atlas.handleAnnotateClick() : atlas.onClick(e as unknown as MouseEvent))}>
      <!-- A12: Glow halo behind everything -->
      <!-- Glow, point annotations and labels around the map are 2D only (T5). -->
      {#if atlas.dims !== 3}<GlowOverlay {atlas} />{/if}
      <LassoLayer {atlas} />
      {#if atlas.dims !== 3}<BrushLayer {atlas} />{/if}
      {#if atlas.dims !== 3}<ShapeLayer {atlas} />{/if}
      <TitleOverlay {atlas} />
      {#if atlas.dims !== 3}<AnnotationOverlay {atlas} />{/if}
      <!-- A11: Around-the-map label HTML overlay -->
      {#if atlas.dims !== 3 && (atlas.labels.labelStyle ?? 'over') === 'around' && atlas.aroundLabelGroups}
        <AroundLabelsOverlay {atlas} />
      {/if}
      {#if atlas.grid.enabled}
        <!-- C1: per-panel titles at bottom-left of each panel, below the data area -->
        {@const rects = gridViewRects(atlas.grid.layout, mainW, mainH, GRID_TOP_BAND_PX)}
        {@const nP = panelCount(atlas.grid.layout)}
        {@const cols = atlas.describe?.columns ?? []}
        {#each atlas.grid.panels.slice(0, nP) as panel, i}
          {@const r = rects[i]}
          <div class="grid-panel-title" style="left:{r.x}px; top:{r.y + r.h - 22}px; width:{r.w}px;">
            {panelTitle(panel, i, atlas.colorColumn, cols)}
          </div>
        {/each}
      {/if}
    </div>
    {#if !atlas.grid.enabled}<Legend {atlas} />{/if}
    {#if atlas.cheatSheetVisible}<CheatSheet {atlas} />{/if}
    {#if atlas.showHint && !atlas.cheatSheetVisible}<NavHint {atlas} />{/if}
    <HoverCard {atlas} />
    {#if atlas.tooltip && !atlas.pinnedCard}
      <div class="tooltip" bind:clientWidth={ttW} bind:clientHeight={ttH} style="left:{ttPos.left}px; top:{ttPos.top}px">
        {#if atlas.tooltip.title}
          <div class="tt-title">{atlas.tooltip.title}</div>
        {:else}
          <div class="tt-title">Row {formatCount(atlas.tooltip.row)}</div>
        {/if}
        {#if atlas.tooltip.imageUri}
          <img class="pixel-image" class:invert-on={atlas.view.imageInvert === true} class:invert-auto={atlas.view.imageInvert === 'auto'} src={atlas.tooltip.imageUri} alt="Row {atlas.tooltip.row}" style="max-width:200px;max-height:150px;object-fit:contain;display:block;margin:2px 0 6px;" />
        {:else if atlas.tooltip.image && atlas.imageShape}
          <PixelImage values={atlas.tooltip.image} width={atlas.imageShape[0]} height={atlas.imageShape[1]} invert={resolveInvert(atlas.view.imageInvert)} />
        {/if}
        {#if atlas.tooltip.values.length}
          <table>
            <tbody>
              {#each atlas.tooltip.values.slice(0, 16) as [k, v]}
                <tr><th>{k}</th><td>{v}</td></tr>
              {/each}
            </tbody>
          </table>
          {#if atlas.tooltip.values.length > 16}<div class="more">+ {atlas.tooltip.values.length - 16} more columns</div>{/if}
        {/if}
        {#if atlas.tooltip.linkValue}
          <div class="tt-link" title={atlas.tooltip.linkValue}>↗ Click to open link</div>
        {/if}
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
