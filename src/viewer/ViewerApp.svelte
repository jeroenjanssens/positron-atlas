<script lang="ts">
  /**
   * Atlas HTML viewer (X1/X3).
   *
   * Renders the embedded blob with deck.gl (via ScatterRenderer).
   * Supports: pan/zoom, hover tooltip, pinned card, legend toggles, search,
   * read-only annotations, labels, title overlay, full screen.
   */
  import { onMount } from 'svelte';
  import { ScatterRenderer } from '../webview/render/renderer';
  import { HitIndex } from '../webview/render/hitIndex';
  import { isValidLink } from '../webview/hover/texts';
  import type { UnpackedBlob, BlobAnnotation, BlobLabel } from '../shared/viewerBlob';
  import type { MapLabel } from '../webview/render/renderer';

  let { blob }: { blob: UnpackedBlob } = $props();

  const { header } = blob;
  const nPoints = header.n;
  const bg = header.bg;

  // ---- renderer ----
  let container: HTMLDivElement;
  let renderer: ScatterRenderer | null = null;
  let hit: HitIndex | null = null;

  // ---- view state ----
  let hiddenCodes = $state(new Set<number>());
  let hoverIdx = $state(-1);
  let pinnedIdx = $state(-1);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipTitle = $state('');
  let tooltipFields = $state<[string, string][]>([]);
  let tooltipLink = $state('');
  let showTooltip = $state(false);
  let showPinned = $state(false);
  let pinnedTitle = $state('');
  let pinnedFields = $state<[string, string][]>([]);
  let pinnedLink = $state('');
  let searchQuery = $state('');
  let searchResults: Set<number> | null = null;
  let isFullscreen = $state(false);
  let containerW = $state(0);
  let containerH = $state(0);

  // Inject font CSS
  if (header.fontCss.length > 0) {
    const style = document.createElement('style');
    style.textContent = header.fontCss.join('\n');
    document.head.appendChild(style);
  }

  // ---- precompute filter values ----
  const noCodeFilter = blob.codes === null;
  let filterValues: Float32Array = new Float32Array(nPoints).fill(1);

  function rebuildFilter(): void {
    if (!blob.codes) { filterValues.fill(1); return; }
    const codes = blob.codes;
    for (let i = 0; i < nPoints; i++) {
      filterValues[i] = hiddenCodes.has(codes[i]) ? 0 : 1;
    }
    applySearchToFilter();
  }

  function applySearchToFilter(): void {
    if (!searchResults) return;
    const base = blob.codes ? filterValues : (filterValues = new Float32Array(nPoints).fill(1));
    for (let i = 0; i < nPoints; i++) {
      if (!searchResults.has(i)) base[i] *= 0.15;
    }
  }

  // ---- tooltip text helpers ----
  const titleColIdx = header.tooltipCols.findIndex((c) => c.isTitle);
  const linkColIdx = header.tooltipCols.findIndex((c) => c.isLink);

  function getTitle(i: number): string {
    if (titleColIdx < 0) return '';
    return blob.getText(titleColIdx, i);
  }
  function getLink(i: number): string {
    if (linkColIdx < 0) return '';
    return blob.getText(linkColIdx, i);
  }
  function getFields(i: number): [string, string][] {
    return header.tooltipCols
      .map((c, ci) => [c.name, blob.getText(ci, i)] as [string, string])
      .filter(([, v]) => v.length > 0);
  }

  // ---- search ----
  function runSearch(q: string): void {
    q = q.trim();
    if (!q) { searchResults = null; applySearchToFilter(); rerenderFilter(); return; }
    const lower = q.toLowerCase();
    const results = new Set<number>();
    // Search title column if available, otherwise all text columns
    const colsToSearch = titleColIdx >= 0 ? [titleColIdx] : header.tooltipCols.map((_, i) => i);
    for (let i = 0; i < nPoints; i++) {
      for (const ci of colsToSearch) {
        if (blob.getText(ci, i).toLowerCase().includes(lower)) { results.add(i); break; }
      }
    }
    searchResults = results;
    rebuildFilter();
    rerenderFilter();
  }

  function rerenderFilter(): void {
    if (!renderer || !blob.codes) return;
    const codes = blob.codes;
    renderer.setPointSets(
      [{ id: 'pts', positions: blob.xy, colors: blob.rgba, length: nPoints, radii: blob.radii ?? undefined }],
      [{ codes, hidden: new Set(), precomputed: filterValues }],
    );
  }

  function rerenderFilterNoCode(): void {
    if (!renderer) return;
    renderer.setPointSets(
      [{ id: 'pts', positions: blob.xy, colors: blob.rgba, length: nPoints, radii: blob.radii ?? undefined }],
      noCodeFilter ? [null] : [{ codes: blob.codes!, hidden: new Set(), precomputed: filterValues }],
    );
  }

  // ---- hover ----
  function onPointer(p: { x: number; y: number; world: [number, number] } | null): void {
    if (!p || !renderer || !hit) {
      showTooltip = false;
      hoverIdx = -1;
      renderer?.setHoverRing(-1, pinnedIdx);
      return;
    }
    const radius = renderer.worldPerPixel() * 10;
    const idx = hit.nearest(p.world[0], p.world[1], radius);
    if (idx < 0 || (blob.codes && hiddenCodes.has(blob.codes[idx]))) {
      showTooltip = false;
      hoverIdx = -1;
      renderer.setHoverRing(-1, pinnedIdx);
      return;
    }
    hoverIdx = idx;
    renderer.setHoverRing(idx, pinnedIdx);
    tooltipX = p.x;
    tooltipY = p.y;
    tooltipTitle = getTitle(idx) || `Point ${idx + 1}`;
    tooltipFields = getFields(idx);
    tooltipLink = getLink(idx);
    showTooltip = true;
  }

  function onClick(): void {
    if (hoverIdx < 0) { showPinned = false; pinnedIdx = -1; renderer?.setHoverRing(hoverIdx, -1); return; }
    pinnedIdx = hoverIdx;
    pinnedTitle = tooltipTitle;
    pinnedFields = tooltipFields;
    pinnedLink = tooltipLink;
    showPinned = true;
    showTooltip = false;
    renderer?.setHoverRing(hoverIdx, hoverIdx);
  }

  function closePinned(): void {
    showPinned = false;
    pinnedIdx = -1;
    renderer?.setHoverRing(hoverIdx, -1);
  }

  function openLink(url: string): void {
    if (isValidLink(url)) window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ---- legend toggles ----
  function toggleCategory(i: number, solo: boolean): void {
    const leg = header.legend;
    if (!leg || leg.kind !== 'categorical') return;
    const total = leg.categories.length;
    if (solo) {
      // Show only this one
      const next = new Set<number>();
      for (let j = 0; j < total; j++) if (j !== i) next.add(j);
      hiddenCodes = next;
    } else {
      const next = new Set(hiddenCodes);
      if (next.has(i)) next.delete(i); else next.add(i);
      hiddenCodes = next;
    }
    rebuildFilter();
    rerenderFilter();
  }

  function showAll(): void {
    hiddenCodes = new Set();
    rebuildFilter();
    rerenderFilter();
  }

  // ---- fullscreen ----
  function toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
  }

  // ---- annotations ----
  let annotationPositions = $state(new Map<string, [number, number]>());
  let annRafId = 0;

  function updateAnnotationPositions(): void {
    if (!renderer) return;
    const next = new Map<string, [number, number]>();
    for (const ann of header.annotations) {
      const pt = renderer.projectWorld(ann.worldX, ann.worldY);
      if (pt) next.set(ann.id, pt);
    }
    annotationPositions = next;
    annRafId = requestAnimationFrame(updateAnnotationPositions);
  }

  onMount(() => {
    // Apply background color
    document.body.style.background = bg;
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.background = bg;

    // Expose state for harness testing
    (window as unknown as Record<string, unknown>).__viewer = {
      get nPoints() { return nPoints; },
      get bg() { return bg; },
      get showTooltip() { return showTooltip; },
      get tooltipTitle() { return tooltipTitle; },
      get tooltipFields() { return tooltipFields; },
      get searchQuery() { return searchQuery; },
      get searchCount() { return searchResults?.size ?? 0; },
      get hasSearch() { return searchResults !== null; },
      get hiddenCount() { return hiddenCodes.size; },
      get legendCategories() { return header.legend && header.legend.kind === 'categorical' ? header.legend.categories.length : 0; },
      get annotationCount() { return header.annotations.length; },
      /**
       * Trigger hover for point at row index `idx` (default: 0).
       * Passes the point's world coordinates so the HitIndex finds the right point.
       * Used by the harness to smoke-test tooltip rendering without deck.gl events.
       */
      triggerHover(idx = 0): number {
        if (idx < 0 || idx >= nPoints) return -1;
        const wx = blob.xy[idx * 2];
        const wy = blob.xy[idx * 2 + 1];
        onPointer({ x: 400, y: 300, world: [wx, wy] as [number, number] });
        return idx;
      },
    };

    renderer = new ScatterRenderer(container);
    renderer.setStyle({ pointSize: 3, opacity: 0.8, mode: 'points' });
    renderer.onPointer(onPointer);
    // Click: handled via container click event
    container.addEventListener('click', onClick);

    hit = new HitIndex(blob.xy, nPoints);

    // Set labels
    if (header.labels.length > 0) {
      const mapLabels: MapLabel[] = header.labels.map((l: BlobLabel) => ({
        text: l.text,
        position: [l.x, l.y] as [number, number],
        size: l.size,
        color: l.color,
        priority: l.priority,
        weight: l.weight,
        badge: l.badge,
      }));
      const bgRgb = hexToRgb(bg);
      renderer.setLabels(mapLabels, {
        outline: [...bgRgb, 255] as [number, number, number, number],
        fontFamily: header.title.fontFamily || 'sans-serif',
      });
    }

    // Initial render
    rerenderFilterNoCode();

    // Auto-fit: import bounds and fit
    import('../webview/render/hitIndex').then(({ bounds }) => {
      renderer?.fit(bounds(blob.xy, nPoints), false, 0);
    });

    // Start annotation position tracking
    annRafId = requestAnimationFrame(updateAnnotationPositions);

    document.addEventListener('fullscreenchange', () => {
      isFullscreen = !!document.fullscreenElement;
    });

    const resizeObs = new ResizeObserver((entries) => {
      const e = entries[0];
      containerW = e.contentRect.width;
      containerH = e.contentRect.height;
    });
    resizeObs.observe(container);

    return () => {
      cancelAnimationFrame(annRafId);
      resizeObs.disconnect();
      container.removeEventListener('click', onClick);
      renderer?.destroy();
    };
  });

  function hexToRgb(hex: string): [number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return [r, g, b];
  }

  // Tooltip placement: flip near edges
  function placeTooltip(pos: number, ttSize: number, total: number): number {
    if (pos + ttSize + 16 > total) return Math.max(0, pos - ttSize - 8);
    return pos + 12;
  }

  let ttW = $state(0);
  let ttH = $state(0);
  const ttPos = $derived.by(() => ({
    left: placeTooltip(tooltipX, ttW, containerW),
    top: placeTooltip(tooltipY, ttH, containerH - 24),
  }));

  // Dark mode detection from background
  const isDark = $derived.by(() => {
    const r = parseInt(bg.slice(1, 3), 16) || 0;
    const g = parseInt(bg.slice(3, 5), 16) || 0;
    const b = parseInt(bg.slice(5, 7), 16) || 0;
    return (r * 0.299 + g * 0.587 + b * 0.114) < 128;
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      if (showPinned) { closePinned(); e.preventDefault(); }
      else if (searchQuery) { searchQuery = ''; runSearch(''); e.preventDefault(); }
    }
    if (e.key === 'f' && e.metaKey) { toggleFullscreen(); e.preventDefault(); }
  }}
/>

<div class="viewer" class:dark={isDark} class:light={!isDark} bind:this={container} bind:clientWidth={containerW} bind:clientHeight={containerH}>

  <!-- Toolbar -->
  <div class="toolbar">
    <input
      class="search-input"
      type="text"
      placeholder="Search…"
      bind:value={searchQuery}
      oninput={() => runSearch(searchQuery)}
      aria-label="Search points"
    />
    <button class="tb-btn" onclick={toggleFullscreen} title="Toggle fullscreen">
      {isFullscreen ? '⊠' : '⊡'}
    </button>
  </div>

  <!-- Legend -->
  {#if header.legend && header.legend.kind === 'categorical'}
    <div class="legend">
      <div class="legend-title">{header.legend.title}</div>
      {#each header.legend.categories as cat, i}
        <div
          class="legend-item"
          class:hidden={hiddenCodes.has(i)}
          role="button"
          tabindex="0"
          title="{(header.legend.counts[i] ?? 0).toLocaleString()} points — click to hide/show, Alt-click to solo"
          onclick={(e) => toggleCategory(i, e.altKey)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleCategory(i, e.altKey)}
        >
          <span class="legend-sw" style="background:{hiddenCodes.has(i) ? '#555' : header.legend.colors[i]}"></span>
          {cat}
        </div>
      {/each}
      {#if hiddenCodes.size > 0}
        <button class="legend-show-all" onclick={showAll}>Show all</button>
      {/if}
    </div>
  {/if}

  <!-- Title overlay -->
  {#if header.title.title.trim() || header.title.subtitle.trim() || header.title.logoData}
    <div class="title-overlay" aria-label="Map title">
      {#if header.title.logoData}
        <img class="title-logo" src={header.title.logoData} alt="Logo"
          style="max-width:{header.title.logoWidth > 0 ? header.title.logoWidth : 48}px" />
      {/if}
      {#if header.title.title.trim()}
        <div class="map-title"
          style="{header.title.fontFamily ? `font-family:'${header.title.fontFamily}',sans-serif;` : ''}{header.title.fontSize ? `font-size:${header.title.fontSize}px;` : ''}{header.title.color ? `color:${header.title.color};` : ''}"
        >{header.title.title}</div>
      {/if}
      {#if header.title.subtitle.trim()}
        <div class="map-subtitle"
          style="{header.title.fontFamily ? `font-family:'${header.title.fontFamily}',sans-serif;` : ''}{header.title.color ? `color:${header.title.color};` : ''}"
        >{header.title.subtitle}</div>
      {/if}
    </div>
  {/if}

  <!-- Hover tooltip -->
  {#if showTooltip && !showPinned}
    <div
      class="tooltip"
      style="left:{ttPos.left}px;top:{ttPos.top}px"
      bind:clientWidth={ttW}
      bind:clientHeight={ttH}
      role="tooltip"
    >
      <div class="tt-title">{tooltipTitle}</div>
      {#if tooltipFields.length > 0}
        <table class="tt-table">
          <tbody>
            {#each tooltipFields.slice(0, 10) as [k, v]}
              <tr><th>{k}</th><td>{v}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if tooltipLink}
        <div class="tt-link">
          <a href={tooltipLink} target="_blank" rel="noopener noreferrer" onclick={(e) => { e.preventDefault(); openLink(tooltipLink); }}>Open link</a>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Pinned card -->
  {#if showPinned}
    <div class="pinned-card" role="dialog" aria-label="Pinned point">
      <div class="pc-header">
        <span class="pc-title"><strong>{pinnedTitle}</strong></span>
        <button class="pc-close" onclick={closePinned} title="Close (Escape)">✕</button>
      </div>
      {#if pinnedFields.length > 0}
        <table class="pc-table">
          <tbody>
            {#each pinnedFields.slice(0, 24) as [k, v]}
              <tr><th>{k}</th><td>{v}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if pinnedLink}
        <div class="pc-link">
          <a href={pinnedLink} target="_blank" rel="noopener noreferrer"
            onclick={(e) => { e.preventDefault(); openLink(pinnedLink); }}>Open link ↗</a>
        </div>
      {/if}
      <div class="pc-hint muted">Click elsewhere or press Escape to close</div>
    </div>
  {/if}

  <!-- Annotation overlay -->
  {#if header.annotations.length > 0}
    <svg class="annotation-svg" aria-hidden="true">
      {#each header.annotations as ann}
        {@const pos = annotationPositions.get(ann.id)}
        {#if pos}
          {@const bx = pos[0] + ann.offsetX}
          {@const by = pos[1] + ann.offsetY}
          <!-- Leader line -->
          <line x1={pos[0]} y1={pos[1]} x2={bx + 60} y2={by + 12}
            stroke={ann.color || '#cccccc'} stroke-width="1" stroke-dasharray="4 3" opacity="0.7" />
        {/if}
      {/each}
    </svg>
    {#each header.annotations as ann}
      {@const pos = annotationPositions.get(ann.id)}
      {#if pos}
        <div
          class="annotation-box"
          class:badge={ann.style === 'badge'}
          style="left:{pos[0] + ann.offsetX}px;top:{pos[1] + ann.offsetY}px;{ann.style === 'badge' && ann.color ? `border-color:${ann.color};` : ''}"
        >
          {#if ann.style === 'image' && ann.imageDataUrl}
            <img src={ann.imageDataUrl} alt="Annotation" style="max-width:120px;max-height:120px;display:block;" />
          {:else}
            {ann.text}
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .viewer {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .viewer.dark {
    --fg: #cccccc;
    --bg: #1e1e1e;
    --panel-bg: rgba(30,30,30,0.92);
    --panel-border: #444;
    --muted: #888;
    --tt-bg: #252526;
    --tt-border: #444;
  }
  .viewer.light {
    --fg: #333333;
    --bg: #ffffff;
    --panel-bg: rgba(255,255,255,0.92);
    --panel-border: #ccc;
    --muted: #666;
    --tt-bg: #f5f5f5;
    --tt-border: #ccc;
  }

  .toolbar {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 20px;
    padding: 4px 10px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .search-input {
    background: transparent;
    border: none;
    outline: none;
    color: var(--fg);
    font-size: 0.9em;
    width: 200px;
  }
  .tb-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--fg);
    font-size: 1.1em;
    padding: 0 4px;
  }

  .legend {
    position: absolute;
    top: 48px;
    right: 12px;
    z-index: 8;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    padding: 8px 10px;
    min-width: 120px;
    max-width: 200px;
    max-height: 50vh;
    overflow-y: auto;
    font-size: 0.82em;
    color: var(--fg);
  }
  .legend-title {
    font-weight: 600;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 1px 2px;
    cursor: pointer;
    border-radius: 2px;
  }
  .legend-item:hover { opacity: 0.8; }
  .legend-item.hidden { opacity: 0.4; }
  .legend-sw {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .legend-show-all {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-top: 1px solid var(--panel-border);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.9em;
    padding: 3px 0;
    margin-top: 3px;
  }

  .title-overlay {
    position: absolute;
    top: 36px;
    left: 12px;
    z-index: 5;
    pointer-events: none;
    max-width: 40%;
  }
  .title-logo { display: block; margin-bottom: 6px; object-fit: contain; }
  .map-title {
    font-size: 24px;
    font-weight: 700;
    color: var(--fg);
    line-height: 1.1;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6), 0 0 2px rgba(0,0,0,0.9);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .map-subtitle {
    font-size: 14px;
    color: var(--fg);
    opacity: 0.75;
    margin-top: 2px;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
    white-space: pre-wrap;
  }

  .tooltip {
    position: absolute;
    z-index: 12;
    background: var(--tt-bg);
    border: 1px solid var(--tt-border);
    color: var(--fg);
    border-radius: 4px;
    padding: 6px 8px;
    max-width: 300px;
    font-size: 0.85em;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  }
  .tt-title { font-weight: 600; margin-bottom: 4px; }
  .tt-table { border-collapse: collapse; font-size: 0.95em; }
  .tt-table th { text-align: left; padding-right: 8px; color: var(--muted); font-weight: normal; }
  .tt-table td { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tt-link { margin-top: 4px; }
  .tt-link a { color: #4da3ff; text-decoration: none; }
  .tt-link a:hover { text-decoration: underline; }

  .pinned-card {
    position: absolute;
    left: 50%;
    top: 60px;
    transform: translateX(-50%);
    z-index: 14;
    background: var(--tt-bg);
    border: 1px solid var(--tt-border);
    color: var(--fg);
    border-radius: 4px;
    padding: 10px 12px;
    max-width: 400px;
    min-width: 200px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    font-size: 0.9em;
  }
  .pc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; }
  .pc-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
  .pc-close {
    background: none; border: none; cursor: pointer; color: var(--muted); font-size: 1em; padding: 0 4px;
  }
  .pc-table { border-collapse: collapse; font-size: 0.9em; width: 100%; }
  .pc-table th { text-align: left; padding-right: 8px; color: var(--muted); font-weight: normal; padding-bottom: 2px; }
  .pc-table td { word-break: break-word; }
  .pc-link { margin-top: 8px; }
  .pc-link a { color: #4da3ff; text-decoration: none; }
  .pc-link a:hover { text-decoration: underline; }
  .pc-hint { font-size: 0.78em; margin-top: 8px; color: var(--muted); }

  .annotation-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 6;
  }
  .annotation-box {
    position: absolute;
    z-index: 7;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    color: var(--fg);
    border-radius: 3px;
    padding: 4px 8px;
    font-size: 0.85em;
    pointer-events: none;
    max-width: 200px;
    word-break: break-word;
    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
  }
  .annotation-box.badge {
    border-width: 2px;
    font-weight: 600;
  }
  .muted { color: var(--muted); }
</style>
