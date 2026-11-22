<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Info from './controls/Info.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let inputValue = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Currently selected layer id for search ('base' = base layer). */
  let searchLayer = $state('base');

  /** Overlay layers that are described (columns known) so search can target them. */
  const searchableOverlays = $derived(
    atlas.layers.filter((l) => l.kind === 'point-overlay' && l.visible && atlas.overlayDescribes.has(l.id))
  );

  /** First text/categorical column of the selected overlay layer, or null if no overlay. */
  const overlaySearchColumn = $derived(
    searchLayer === 'base' ? null : (() => {
      const cols = atlas.overlayDescribes.get(searchLayer) ?? [];
      const c = cols.find((col) => col.kind === 'categorical' || col.kind === 'other');
      return c ? c.index : (cols.length > 0 ? cols[0].index : null);
    })()
  );

  /** Post the query after a 300 ms debounce. */
  function scheduleSearch(val: string): void {
    clearTimeout(debounceTimer);
    if (!val.trim()) {
      if (searchLayer === 'base') atlas.clearSearch();
      else atlas.clearSearchOverlay();
      return;
    }
    debounceTimer = setTimeout(() => {
      runSearchNow(val.trim());
    }, 300);
  }

  function runSearchNow(q: string): void {
    if (searchLayer !== 'base') {
      const col = overlaySearchColumn;
      if (col !== null) atlas.runSearchOverlay(searchLayer, col, q);
    } else {
      atlas.search(q);
    }
  }

  function onInput(e: Event): void {
    inputValue = (e.target as HTMLInputElement).value;
    scheduleSearch(inputValue);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      if (inputValue.trim()) {
        runSearchNow(inputValue.trim());
        // Zoom after a short yield so the mask has been applied (base only).
        if (searchLayer === 'base') setTimeout(() => atlas.zoomToSearchMatches(), 50);
      }
      e.preventDefault();
    } else if (e.key === 'Escape') {
      clearTimeout(debounceTimer);
      inputValue = '';
      if (searchLayer === 'base') atlas.clearSearch();
      else atlas.clearSearchOverlay();
      e.preventDefault();
    }
  }

  function onLayerChange(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    // Clear any existing search when switching layers.
    if (searchLayer === 'base') atlas.clearSearch();
    else atlas.clearSearchOverlay();
    searchLayer = v;
    inputValue = '';
  }

  // Keep the input in sync when clearSearch is called externally.
  $effect(() => {
    if (!atlas.searchQuery && inputValue) {
      inputValue = '';
    }
  });

  const showCount = $derived(!!atlas.searchQuery && !atlas.searchPending);
  const disabled = $derived(atlas.phase !== 'ready' || (searchLayer === 'base' ? atlas.searchColumnIndex === null : overlaySearchColumn === null));
</script>

<div class="search-box" role="search">
  {#if searchableOverlays.length > 0}
    <select class="layer-pick" aria-label="Search layer" onchange={onLayerChange}>
      <option value="base">Base</option>
      {#each searchableOverlays as layer (layer.id)}
        <option value={layer.id}>{layer.name}</option>
      {/each}
    </select>
  {/if}
  <span class="codicon codicon-search search-icon" aria-hidden="true"></span>
  <input
    bind:this={inputEl}
    type="search"
    class="search-input"
    class:has-results={showCount && atlas.searchMatchCount > 0}
    class:no-results={showCount && atlas.searchMatchCount === 0}
    value={inputValue}
    placeholder="Search…"
    aria-label="Search the map"
    {disabled}
    oninput={onInput}
    onkeydown={onKeyDown}
  />
  {#if atlas.searchPending}
    <span class="search-status muted" aria-live="polite">…</span>
  {:else if showCount}
    <span class="search-status" class:muted={atlas.searchMatchCount === 0} aria-live="polite">
      {atlas.searchMatchCount.toLocaleString()}
    </span>
  {/if}
  <Info id="search.query" />
</div>

<style>
  .search-box {
    position: absolute;
    left: 8px;
    top: 44px;   /* below the 28px toolbar + 8px gap */
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--action-bar-bg, var(--editor-background)) 92%, transparent);
    border: 1px solid var(--border, #444);
    height: 28px;
    min-width: 160px;
  }
  .layer-pick {
    background: none;
    border: none;
    border-right: 1px solid var(--border, #444);
    outline: none;
    color: var(--foreground, inherit);
    font-size: 11px;
    padding: 0 2px;
    cursor: pointer;
    flex: none;
    max-width: 70px;
  }
  .search-icon {
    color: var(--muted, #888);
    font-size: 13px;
    flex: none;
    pointer-events: none;
  }
  .search-input {
    background: none;
    border: none;
    outline: none;
    color: var(--foreground, inherit);
    font-size: 12px;
    width: 110px;
    min-width: 60px;
    padding: 0 2px;
    appearance: none;
    -webkit-appearance: none;
  }
  .search-input::placeholder { color: var(--muted, #888); }
  .search-input:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Remove the native × button in Chrome/Safari so we can use Escape instead */
  .search-input::-webkit-search-cancel-button { display: none; }
  .search-status {
    font-size: 11px;
    white-space: nowrap;
    flex: none;
    color: var(--foreground, inherit);
  }
  .search-status.muted { color: var(--muted, #888); }
</style>
