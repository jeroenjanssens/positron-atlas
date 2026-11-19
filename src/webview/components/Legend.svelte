<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import { CATEGORICAL, NULL_COLOR, OTHER_COLOR, cssGradient } from '../color/colormaps';
  let { atlas }: { atlas: Atlas } = $props();
  const meta = $derived(atlas.colorMeta);

  function fmt(v: number | undefined, isDate: boolean): string {
    if (v === undefined || v === null) return '–';
    if (isDate) return new Date(v / 1e6).toISOString().slice(0, 10);
    const a = Math.abs(v);
    return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : Number(v.toPrecision(4)).toString();
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
        <div class="item" title="{meta.counts[i].toLocaleString()} rows">
          <span class="sw" style="background:{CATEGORICAL[i % CATEGORICAL.length]}"></span>{cat === '' ? '(empty)' : cat}
        </div>
      {/each}
      {#if meta.otherCount}<div class="item"><span class="sw" style="background:{OTHER_COLOR}"></span>other ({(meta.nUnique - meta.categories.length).toLocaleString()} values)</div>{/if}
      {#if meta.nullCount}<div class="item"><span class="sw" style="background:{NULL_COLOR}"></span>missing</div>{/if}
    {/if}
  </div>
{/if}
