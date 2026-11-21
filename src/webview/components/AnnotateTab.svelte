<script lang="ts">
  import { MAX_LABELS, type Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import { formatCount } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  // Columns that can label the map: categories, booleans, and integers with few distinct values.
  const labelColumns = $derived(
    (atlas.describe?.columns ?? []).filter(
      (c) =>
        c.kind === 'categorical' ||
        c.kind === 'bool' ||
        (c.kind === 'numeric' && /int/i.test(c.dtype) && (c.n_unique_est ?? Infinity) <= MAX_LABELS),
    ),
  );
  const meta = $derived(atlas.labelMeta);
  const sameAsColor = $derived(atlas.labels.column !== null && atlas.labels.column === atlas.colorColumn && atlas.colorMeta?.kind === 'categorical');

  function onLabelChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setLabelColumn(v === '' ? null : Number(v));
  }
</script>

<Section {atlas} id="labels" title="Labels">
  <label class="select" title="Write the values of a column on the map, at the densest spot of each group of points">
    <span>Label by</span>
    <select value={atlas.labels.column === null ? '' : String(atlas.labels.column)} onchange={onLabelChange} aria-label="Label by">
      <option value="">None</option>
      {#each labelColumns as c (c.index)}<option value={String(c.index)}>{c.name}</option>{/each}
    </select>
  </label>
  {#if labelColumns.length === 0}
    <div class="hint muted">No column to label by: labels need a text, categorical, boolean or integer column.</div>
  {/if}
  {#if atlas.labels.column !== null}
    <Slider label="Smallest label" bind:value={atlas.labels.minSize} min={6} max={40} hint="Font size (pixels) of labels for the smallest groups"
      onchange={(v) => atlas.setLabelOptions({ minSize: v, maxSize: Math.max(v, atlas.labels.maxSize) })} />
    <Slider label="Largest label" bind:value={atlas.labels.maxSize} min={6} max={64} hint="Font size (pixels) of the label of the largest group"
      onchange={(v) => atlas.setLabelOptions({ maxSize: v, minSize: Math.min(v, atlas.labels.minSize) })} />
    {#if sameAsColor}
      <label class="check" title="Color each label like its points">
        <input type="checkbox" checked={atlas.labels.colorText} onchange={(e) => atlas.setLabelOptions({ colorText: (e.target as HTMLInputElement).checked })} />
        Color labels like the points
      </label>
    {/if}
    {#if meta}
      <div class="hint muted">
        {formatCount(atlas.labelCount)} labels{#if meta.nUnique > meta.categories.length}, for the {formatCount(meta.categories.length)} most frequent of {formatCount(meta.nUnique)} values{/if}.
        Bigger groups get bigger labels. Labels that would overlap are hidden; zoom in to see more.
      </div>
    {:else}
      <div class="hint muted">Loading labels…</div>
    {/if}
  {/if}
</Section>
