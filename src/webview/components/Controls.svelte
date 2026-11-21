<script lang="ts">
  import type { Atlas, SidebarTab } from '../atlas.svelte';
  import MapTab from './MapTab.svelte';
  import ExploreTab from './ExploreTab.svelte';
  import { formatCount } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  const tabs: { id: SidebarTab; label: string; hint: string }[] = [
    { id: 'map', label: 'Map', hint: 'How the map is computed: data, UMAP and placing all rows' },
    { id: 'explore', label: 'Explore', hint: 'What is in the map: colors, display and selection' },
  ];

  function onKey(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === atlas.ui.tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (next === -1) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    atlas.setTab(t.id);
    document.getElementById(`tab-${t.id}`)?.focus();
  }
</script>

<div class="controls">
  <header>
    <h1 title={atlas.variable}>{atlas.variable}</h1>
    {#if atlas.describe}
      <div class="sub">
        {atlas.describe.frameKind} · {formatCount(atlas.describe.nRows)} rows × {formatCount(atlas.describe.nCols)} columns
      </div>
    {/if}
  </header>

  <div class="tabs" role="tablist" aria-label="Control groups" tabindex="-1" onkeydown={onKey}>
    {#each tabs as t (t.id)}
      <button id="tab-{t.id}" role="tab" class="tab" class:active={atlas.ui.tab === t.id} aria-selected={atlas.ui.tab === t.id}
        aria-controls="panel-{t.id}" tabindex={atlas.ui.tab === t.id ? 0 : -1} title={t.hint} onclick={() => atlas.setTab(t.id)}>{t.label}</button>
    {/each}
  </div>

  <!-- All panels stay mounted (hidden when inactive) so their state survives tab switches. -->
  <div id="panel-map" class="tab-panel" role="tabpanel" aria-labelledby="tab-map" hidden={atlas.ui.tab !== 'map'}>
    <MapTab {atlas} />
  </div>
  <div id="panel-explore" class="tab-panel" role="tabpanel" aria-labelledby="tab-explore" hidden={atlas.ui.tab !== 'explore'}>
    <ExploreTab {atlas} />
  </div>
</div>
