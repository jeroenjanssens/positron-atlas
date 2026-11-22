<script lang="ts">
  import { MAX_LABELS, type Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
  import { formatCount } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  const labelColumns = $derived(
    (atlas.describe?.columns ?? []).filter(
      (c) =>
        c.kind === 'categorical' ||
        c.kind === 'bool' ||
        (c.kind === 'numeric' && /int/i.test(c.dtype) && (c.n_unique_est ?? Infinity) <= MAX_LABELS),
    ),
  );
  const meta = $derived(atlas.labelMeta);
  // "Color labels like the points" is only available when labels and colors use the same column.
  const sameAsColor = $derived(atlas.labels.column !== null && atlas.labels.column === atlas.colorColumn && atlas.colorMeta?.kind === 'categorical');

  const source = $derived(atlas.labels.clusters ? 'clusters' : atlas.labels.column === null ? '' : String(atlas.labels.column));
  const detailNames = ['Coarsest', 'Coarse', 'Medium', 'Fine', 'Finest'];
  let tag = $state('');
  let tagColumn = $state('atlas_tag');

  function onLabelChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setLabelSource(v === '' ? null : v === 'clusters' ? 'clusters' : Number(v));
  }
  function onNameByChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setLabelOptions({ nameBy: v === 'number' || v === 'features' ? v : Number(v) });
  }
</script>

<Section {atlas} id="labels" title="Labels">
  <div class="select">
    <span>Label by <Info id="labels.labelBy" /></span>
    <Select value={source} ariaLabel="Label by" onchange={onLabelChange}>
      <option value="">None</option>
      <option value="clusters">Automatic clusters</option>
      {#if labelColumns.length}
        <optgroup label="Columns">
          {#each labelColumns as c (c.index)}<option value={String(c.index)}>{c.name}</option>{/each}
        </optgroup>
      {/if}
    </Select>
  </div>
  {#if atlas.labels.clusters}
    <Slider label="Detail" value={atlas.labels.detail} min={1} max={5} format={(v) => detailNames[v - 1] ?? ''}
      hint="How finely the layout is split into clusters: 1 gives fewer, larger clusters; 5 more, smaller ones"
      onchange={(v) => atlas.setLabelOptions({ detail: v })} infoId="labels.detail" />
    <div class="select">
      <span>Name by <Info id="labels.nameBy" /></span>
      <Select value={String(atlas.labels.nameBy)} ariaLabel="Name clusters by" onchange={onNameByChange}>
        <option value="number">Number</option>
        <option value="features">Distinguishing columns</option>
        {#if labelColumns.length}
          <optgroup label="Most common value of">
            {#each labelColumns as c (c.index)}<option value={String(c.index)}>{c.name}</option>{/each}
          </optgroup>
        {/if}
      </Select>
    </div>
    <Checkbox
      checked={atlas.labels.outlines}
      onchange={(v) => atlas.setLabelOptions({ outlines: v })}>
      Show outlines <Info id="labels.outlines" />
    </Checkbox>
    <div class="btn-row">
      <button disabled={!atlas.clusterCount || atlas.clustering} onclick={() => atlas.clustersToFrame('atlas_cluster')}
        title="Write each row's cluster name into the column atlas_cluster of the DataFrame (rows in no cluster: missing)">Add clusters to DataFrame</button>
      <Info id="labels.addToFrame" />
    </div>
    <div class="hint muted">
      {#if atlas.clustering}
        Finding clusters…
      {:else if atlas.clusterCount}
        {formatCount(atlas.clusterCount)} clusters, found in the density of the layout when it settles.
        {#if atlas.labels.nameBy === 'features'}Names show the columns whose means differ most (↑ higher, ↓ lower).{/if}
      {:else if atlas.phase === 'embedding'}
        Clusters are found when the layout settles.
      {:else}
        No clusters yet.
      {/if}
    </div>
  {/if}
  {#if labelColumns.length === 0 && !atlas.labels.clusters}
    <div class="hint muted">No column to label by: labels need a text, categorical, boolean or integer column.</div>
  {/if}
  {#if atlas.labels.column !== null || atlas.labels.clusters}
    <Slider label="Smallest label" bind:value={atlas.labels.minSize} min={6} max={40}
      hint="Font size (pixels) of labels for the smallest groups"
      onchange={(v) => atlas.setLabelOptions({ minSize: v, maxSize: Math.max(v, atlas.labels.maxSize) })}
      infoId="labels.minSize" />
    <Slider label="Largest label" bind:value={atlas.labels.maxSize} min={6} max={64}
      hint="Font size (pixels) of the label of the largest group"
      onchange={(v) => atlas.setLabelOptions({ maxSize: v, minSize: Math.min(v, atlas.labels.minSize) })}
      infoId="labels.maxSize" />
    {#if sameAsColor}
      <Checkbox
        checked={atlas.labels.colorText}
        onchange={(v) => atlas.setLabelOptions({ colorText: v })}>
        Color labels like the points <Info id="labels.colorText" />
      </Checkbox>
    {:else if atlas.labels.column !== null || atlas.labels.clusters}
      <div class="hint muted" title="Color labels like the points is only available when the label column and color column are the same">
        Color labels like the points (available when labeling and coloring by the same column)
      </div>
    {/if}
    {#if atlas.labels.clusters}
      {#if atlas.labelCount}<div class="hint muted">Bigger clusters get bigger labels. Labels that would overlap are hidden; zoom in to see more.</div>{/if}
    {:else if meta}
      <div class="hint muted">
        {formatCount(atlas.labelCount)} labels{#if meta.nUnique > meta.categories.length}, for the {formatCount(meta.categories.length)} most frequent of {formatCount(meta.nUnique)} values{/if}.
        Bigger groups get bigger labels. Labels that would overlap are hidden; zoom in to see more.
      </div>
    {:else}
      <div class="hint muted">Loading labels…</div>
    {/if}
  {/if}
</Section>

<Section {atlas} id="tags" title="Tags">
  <label class="select">
    <span>Tag <Info id="tags.tag" /></span>
    <input class="text" type="text" placeholder="e.g. outliers" bind:value={tag} aria-label="Tag" />
  </label>
  <label class="select">
    <span>Column <Info id="tags.column" /></span>
    <input class="text" type="text" bind:value={tagColumn} aria-label="Tag column" />
  </label>
  <div class="btn-row">
    <button class="primary" disabled={!atlas.selection || !tag.trim() || !tagColumn.trim()} onclick={() => atlas.tagSelection(tag, tagColumn)}>
      {atlas.selection ? `Tag ${formatCount(atlas.selectedCount)} selected rows` : 'Tag selected rows'}
    </button>
    <Info id="tags.apply" />
  </div>
  <div class="hint muted">
    {#if !atlas.selection}Select points first, with the lasso tool or Shift-drag.{:else}Writes the tag into {tagColumn.trim() || 'the column'} of {atlas.variable}; you can then color or label by it.{/if}
  </div>
</Section>
