<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import { NULL_COLOR, OTHER_COLOR, cssGradient } from '../color/colormaps';
  let { atlas }: { atlas: Atlas } = $props();
  const meta = $derived(atlas.colorMeta);

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
</script>

{#if meta && atlas.colorColumn !== null}
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
</style>
