<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Select from './controls/Select.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Info from './controls/Info.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  const textCols = $derived(
    (atlas.describe?.columns ?? []).filter((c) => c.kind === 'categorical' || c.kind === 'other'),
  );
  const allCols = $derived(atlas.describe?.columns ?? []);

  function onTitleChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.tooltipOpts = { ...atlas.tooltipOpts, titleColumn: v === '' ? undefined : Number(v) };
  }

  function onLinkChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.tooltipOpts = { ...atlas.tooltipOpts, linkColumn: v === '' ? undefined : Number(v) };
  }

  function onImageUrlChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.tooltipOpts = { ...atlas.tooltipOpts, imageUrlColumn: v === '' ? undefined : Number(v) };
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
</script>

<Section {atlas} id="tooltip" title="Tooltip">
  <div class="select">
    <span>Title column <Info id="tooltip.titleColumn" /></span>
    <Select
      value={atlas.tooltipOpts.titleColumn === null || atlas.tooltipOpts.titleColumn === undefined ? '' : String(atlas.tooltipOpts.titleColumn)}
      ariaLabel="Title column"
      onchange={onTitleChange}
    >
      <option value="">(none / auto)</option>
      {#each textCols as c (c.index)}
        <option value={String(c.index)}>{c.name}</option>
      {/each}
    </Select>
  </div>

  <div class="select">
    <span>Fields <Info id="tooltip.fields" /></span>
    <Select value={atlas.tooltipOpts.fieldMode} ariaLabel="Fields" onchange={onFieldModeChange}>
      <option value="none">None</option>
      <option value="all">All columns</option>
      <option value="chosen">Chosen columns</option>
    </Select>
  </div>

  {#if atlas.tooltipOpts.fieldMode === 'chosen'}
    <div class="field-list">
      {#each allCols as c (c.index)}
        {#if c.kind !== 'other'}
          <Checkbox
            checked={atlas.tooltipOpts.fieldColumns.includes(c.index)}
            onchange={(v) => toggleFieldCol(c.index, v)}
          >{c.name}</Checkbox>
        {/if}
      {/each}
    </div>
  {/if}

  <div class="select">
    <span>Link column <Info id="tooltip.linkColumn" /></span>
    <Select
      value={atlas.tooltipOpts.linkColumn === null || atlas.tooltipOpts.linkColumn === undefined ? '' : String(atlas.tooltipOpts.linkColumn)}
      ariaLabel="Link column"
      onchange={onLinkChange}
    >
      <option value="">(none / auto)</option>
      {#each textCols as c (c.index)}
        <option value={String(c.index)}>{c.name}</option>
      {/each}
    </Select>
  </div>

  <div class="select">
    <span>Image URL column <Info id="tooltip.imageUrlColumn" /></span>
    <Select
      value={atlas.tooltipOpts.imageUrlColumn === null || atlas.tooltipOpts.imageUrlColumn === undefined ? '' : String(atlas.tooltipOpts.imageUrlColumn)}
      ariaLabel="Image URL column"
      onchange={onImageUrlChange}
    >
      <option value="">(none / auto)</option>
      {#each textCols as c (c.index)}
        <option value={String(c.index)}>{c.name}</option>
      {/each}
    </Select>
  </div>

  {#if atlas.tooltipOpts.imageUrlColumn !== null && atlas.tooltipOpts.imageUrlColumn !== undefined}
    <div class="select">
      <span>Load images <Info id="tooltip.loadImages" /></span>
      <Select value={atlas.loadImagesFromUrls} ariaLabel="Load images" onchange={(e) => { atlas.loadImagesFromUrls = (e.target as HTMLSelectElement).value as 'always' | 'never' | 'ask'; }}>
        <option value="ask">Ask first</option>
        <option value="always">Always</option>
        <option value="never">Never</option>
      </Select>
    </div>
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
