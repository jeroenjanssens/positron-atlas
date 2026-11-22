<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import { NULL_COLOR, NOISE_COLOR, OTHER_COLOR, cssGradient } from '../color/colormaps';
  import { symbolName } from '../atlas/symbols';
  let { atlas }: { atlas: Atlas } = $props();
  const meta = $derived(atlas.colorMeta);
  const overlayLayers = $derived(atlas.layers.filter((l) => l.kind === 'point-overlay' && l.visible));

  function fmt(v: number | undefined, isDate: boolean): string {
    if (v === undefined || v === null) return '–';
    if (isDate) return new Date(v / 1e6).toISOString().slice(0, 10);
    const a = Math.abs(v);
    return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : Number(v.toPrecision(4)).toString();
  }

  function handleItemClick(e: MouseEvent, i: number) {
    atlas.toggleCategory(i, e.altKey);
    e.preventDefault();
  }

  /** Convert per-overlay RGBA Uint8Array first row to a CSS rgba() string. */
  function overlayCss(layerId: string): string {
    const buf = atlas.overlayColors.get(layerId);
    if (!buf || buf.length < 4) return '#888';
    return `rgba(${buf[0]},${buf[1]},${buf[2]},${(buf[3] / 255).toFixed(2)})`;
  }
</script>

{#if atlas.colorByCluster && atlas.clusterCount > 0 && atlas.cluster}
  <div class="legend">
    <div class="legend-title">Clusters</div>
    {#each Array.from({ length: atlas.cluster.k }, (_, i) => i) as i}
      {@const name = atlas.clusterNames[i] ?? `Cluster ${i + 1}`}
      {@const hex = atlas.categoryColor(i)}
      <div class="item" title="{(atlas.cluster?.counts[i] ?? 0).toLocaleString()} rows">
        <span class="sw" style="background:{hex}"></span>{name}
      </div>
    {/each}
    <div class="item" title="Noise/unlabelled points">
      <span class="sw" style="background:{NOISE_COLOR}"></span>Unlabelled
    </div>
  </div>
{:else if meta && atlas.colorColumn !== null}
  <div class="legend">
    <div class="legend-title">{atlas.describe?.columns[atlas.colorColumn]?.name}</div>
    {#if meta.kind === 'numeric'}
      <div class="bar" style="background: {cssGradient(atlas.view.colormap)}"></div>
      <div class="ticks">
        <span>{fmt(atlas.colorRange?.[0], meta.isDatetime)}</span>
        <span>{fmt(atlas.colorRange?.[1], meta.isDatetime)}</span>
      </div>
      {#if meta.nullCount}<div class="item"><span class="sw" style="background:{NULL_COLOR}"></span>missing ({meta.nullCount.toLocaleString()})</div>{/if}
    {:else}
      {#each meta.categories as cat, i}
        <div
          class="item"
          class:hidden={atlas.isCategoryHidden(i)}
          title="{meta.counts[i].toLocaleString()} rows — click to hide/show, Alt-click to solo"
          role="button"
          tabindex="0"
          onclick={(e) => handleItemClick(e, i)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && handleItemClick(e as unknown as MouseEvent, i)}
        >
          <span class="sw" style="background:{atlas.isCategoryHidden(i) ? '#555' : atlas.categoryColor(i)}"></span>
          {cat === '' ? '(empty)' : cat}
        </div>
      {/each}
      {#if meta.otherCount}<div class="item"><span class="sw" style="background:{OTHER_COLOR}"></span>other ({(meta.nUnique - meta.categories.length).toLocaleString()} values)</div>{/if}
      {#if meta.nullCount}<div class="item"><span class="sw" style="background:{NULL_COLOR}"></span>missing</div>{/if}
      {#if atlas.anyHidden}
        <div class="show-all">
          <button class="link" onclick={() => atlas.showAllCategories()}>Show all</button>
        </div>
      {/if}
    {/if}
  </div>
{/if}

{#if atlas.symbolColumn !== null && atlas.symbolCategories.length > 0}
  <div class="legend symbol-legend">
    <div class="legend-title">{atlas.describe?.columns[atlas.symbolColumn]?.name ?? 'Symbol'}</div>
    {#each atlas.symbolCategories as cat, code (code)}
      {@const sym = symbolName(code)}
      <div class="item sym-item">
        <svg class="sym-icon" viewBox="0 0 10 10" fill="var(--foreground, #ccc)" stroke="none" aria-hidden="true">
          {#if sym === 'circle'}
            <circle cx="5" cy="5" r="4"/>
          {:else if sym === 'square'}
            <rect x="1" y="1" width="8" height="8"/>
          {:else if sym === 'triangle'}
            <polygon points="5,1 9,9 1,9"/>
          {:else if sym === 'diamond'}
            <polygon points="5,1 9,5 5,9 1,5"/>
          {:else if sym === 'cross'}
            <rect x="3.5" y="1" width="3" height="8"/>
            <rect x="1" y="3.5" width="8" height="3"/>
          {:else if sym === 'star'}
            <polygon points="5,0.5 6.2,3.8 9.8,3.8 7,6 8,9.5 5,7.5 2,9.5 3,6 0.2,3.8 3.8,3.8"/>
          {:else if sym === 'hexagon'}
            <polygon points="5,0.5 9,2.75 9,7.25 5,9.5 1,7.25 1,2.75"/>
          {:else}
            <rect x="3.5" y="1" width="3" height="8" transform="rotate(45 5 5)"/>
            <rect x="1" y="3.5" width="8" height="3" transform="rotate(45 5 5)"/>
          {/if}
        </svg>
        <span class="sym-label">{cat === '' ? '(empty)' : cat}</span>
      </div>
    {/each}
  </div>
{/if}

{#if overlayLayers.length > 0}
  <div class="legend overlay-legend">
    <div class="legend-title">Overlays</div>
    {#each overlayLayers as layer (layer.id)}
      {@const css = overlayCss(layer.id)}
      {@const sym = symbolName(layer.symbol ?? 0)}
      {@const nKept = atlas.overlayNKept.get(layer.id) ?? 0}
      <div class="item overlay-item" title="{nKept.toLocaleString()} rows — {layer.sourceName ?? layer.name}">
        <span class="sw" style="background:{css}"></span>
        <svg class="sym-icon" viewBox="0 0 10 10" fill={css} stroke="none" aria-hidden="true">
          {#if sym === 'circle'}
            <circle cx="5" cy="5" r="4"/>
          {:else if sym === 'square'}
            <rect x="1" y="1" width="8" height="8"/>
          {:else if sym === 'triangle'}
            <polygon points="5,1 9,9 1,9"/>
          {:else if sym === 'diamond'}
            <polygon points="5,1 9,5 5,9 1,5"/>
          {:else if sym === 'cross'}
            <rect x="3.5" y="1" width="3" height="8"/>
            <rect x="1" y="3.5" width="8" height="3"/>
          {:else if sym === 'star'}
            <polygon points="5,0.5 6.2,3.8 9.8,3.8 7,6 8,9.5 5,7.5 2,9.5 3,6 0.2,3.8 3.8,3.8"/>
          {:else if sym === 'hexagon'}
            <polygon points="5,0.5 9,2.75 9,7.25 5,9.5 1,7.25 1,2.75"/>
          {:else}
            <!-- x -->
            <rect x="3.5" y="1" width="3" height="8" transform="rotate(45 5 5)"/>
            <rect x="1" y="3.5" width="8" height="3" transform="rotate(45 5 5)"/>
          {/if}
        </svg>
        <span class="overlay-name">{layer.name}</span>
        <span class="overlay-count">({nKept.toLocaleString()})</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .item {
    cursor: pointer;
    user-select: none;
  }
  .item:hover { opacity: 0.8; }
  .item.hidden { opacity: 0.4; }
  .show-all {
    margin-top: 4px;
    border-top: 1px solid var(--border, #333);
    padding-top: 4px;
  }
  .symbol-legend {
    margin-top: 6px;
  }
  .sym-item {
    cursor: default;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .sym-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overlay-legend {
    margin-top: 6px;
  }
  .overlay-item {
    cursor: default;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .sym-icon {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
  }
  .overlay-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overlay-count {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 10px;
    flex-shrink: 0;
  }
</style>
