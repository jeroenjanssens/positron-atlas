<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  const textCols = $derived(
    (atlas.describe?.columns ?? []).filter((c) => c.kind === 'categorical' || c.kind === 'other'),
  );
  const allCols = $derived(atlas.describe?.columns ?? []);

  function onTitleChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.tooltipOpts = { ...atlas.tooltipOpts, titleColumn: v === '' ? null : Number(v) };
  }

  function onLinkChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.tooltipOpts = { ...atlas.tooltipOpts, linkColumn: v === '' ? null : Number(v) };
  }

  function onImageUrlChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.tooltipOpts = { ...atlas.tooltipOpts, imageUrlColumn: v === '' ? null : Number(v) };
  }

  function onFieldModeChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value as 'none' | 'chosen' | 'all';
    atlas.tooltipOpts = { ...atlas.tooltipOpts, fieldMode: v };
  }

  function toggleFieldCol(idx: number, checked: boolean) {
    const cols = atlas.tooltipOpts.fieldColumns;
    const next = checked ? [...cols, idx].sort((a, b) => a - b) : cols.filter((i) => i !== idx);
    atlas.tooltipOpts = { ...atlas.tooltipOpts, fieldColumns: next };
  }

  function onPermChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value as 'always' | 'never' | 'ask';
    atlas.loadImagesFromUrls = v;
  }
</script>

<Section {atlas} id="tooltip" title="Tooltip">
  <label class="select">
    <span>Title column</span>
    <select value={atlas.tooltipOpts.titleColumn === null || atlas.tooltipOpts.titleColumn === undefined ? '' : String(atlas.tooltipOpts.titleColumn)} onchange={onTitleChange}>
      <option value="">(none)</option>
      {#each textCols as c (c.index)}
        <option value={String(c.index)}>{c.name}</option>
      {/each}
    </select>
  </label>

  <label class="select">
    <span>Fields</span>
    <select value={atlas.tooltipOpts.fieldMode} onchange={onFieldModeChange}>
      <option value="none">None</option>
      <option value="all">All columns</option>
      <option value="chosen">Chosen columns</option>
    </select>
  </label>

  {#if atlas.tooltipOpts.fieldMode === 'chosen'}
    <div class="field-list">
      {#each allCols as c (c.index)}
        {#if c.kind !== 'other'}
          <label class="check">
            <input type="checkbox"
              checked={atlas.tooltipOpts.fieldColumns.includes(c.index)}
              onchange={(e) => toggleFieldCol(c.index, (e.target as HTMLInputElement).checked)} />
            {c.name}
          </label>
        {/if}
      {/each}
    </div>
  {/if}

  <label class="select">
    <span>Link column</span>
    <select value={atlas.tooltipOpts.linkColumn === null || atlas.tooltipOpts.linkColumn === undefined ? '' : String(atlas.tooltipOpts.linkColumn)} onchange={onLinkChange}>
      <option value="">(none)</option>
      {#each textCols as c (c.index)}
        <option value={String(c.index)}>{c.name}</option>
      {/each}
    </select>
  </label>

  <label class="select">
    <span>Image URL column</span>
    <select value={atlas.tooltipOpts.imageUrlColumn === null || atlas.tooltipOpts.imageUrlColumn === undefined ? '' : String(atlas.tooltipOpts.imageUrlColumn)} onchange={onImageUrlChange}>
      <option value="">(none)</option>
      {#each textCols as c (c.index)}
        <option value={String(c.index)}>{c.name}</option>
      {/each}
    </select>
  </label>

  {#if atlas.tooltipOpts.imageUrlColumn !== null && atlas.tooltipOpts.imageUrlColumn !== undefined}
    <label class="select">
      <span>Load images</span>
      <select value={atlas.loadImagesFromUrls} onchange={onPermChange}>
        <option value="ask">Ask first</option>
        <option value="always">Always</option>
        <option value="never">Never</option>
      </select>
    </label>
  {/if}
</Section>

<style>
  .field-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 160px;
    overflow-y: auto;
    padding: 4px 0;
  }
</style>
