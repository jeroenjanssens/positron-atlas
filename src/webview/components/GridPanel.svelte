<script lang="ts">
  /**
   * Grid mode configuration panel (C1, item 4).
   * Shown in the Explore tab when grid mode is enabled.
   * Controls: layout picker, per-panel color column selectors.
   */
  import type { Atlas } from '../atlas.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Select from './controls/Select.svelte';
  import Section from './Section.svelte';
  import Info from './controls/Info.svelte';
  import { panelCount, panelTitle } from '../atlas/grid';
  import type { GridLayout } from '../atlas/grid';

  let { atlas }: { atlas: Atlas } = $props();

  const LAYOUTS: { value: GridLayout; label: string }[] = [
    { value: '1x2', label: '1 × 2 (2 panels)' },
    { value: '2x2', label: '2 × 2 (4 panels)' },
    { value: '2x3', label: '2 × 3 (6 panels)' },
    { value: '3x3', label: '3 × 3 (9 panels)' },
  ];

  function onLayoutChange(e: Event) {
    atlas.setGridLayout((e.target as HTMLSelectElement).value as GridLayout);
  }

  function onPanelColorChange(panelIndex: number, e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setPanelColorColumn(panelIndex, v === '' ? null : Number(v));
  }

  const columns = $derived(atlas.describe?.columns ?? []);
  const nPanels = $derived(panelCount(atlas.grid.layout));
  const activePanels = $derived(atlas.grid.panels.slice(0, nPanels));
</script>

<Section {atlas} id="grid" title="Grid mode">
  <Checkbox
    checked={atlas.grid.enabled}
    onchange={() => atlas.toggleGrid()}
  >
    Show small multiples <Info id="grid.enabled" />
  </Checkbox>

  {#if atlas.grid.enabled}
    <div class="grid-layout-row">
      <span class="ctrl-label">Layout <Info id="grid.layout" /></span>
      <Select value={atlas.grid.layout} ariaLabel="Grid layout" onchange={onLayoutChange}>
        {#each LAYOUTS as opt}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </Select>
    </div>

    <div class="grid-panel-list">
      {#each activePanels as panel, i}
        <div class="grid-panel-row">
          <span class="panel-label">
            {panelTitle(panel, i, atlas.colorColumn, columns)}
          </span>
          <Select
            value={panel.colorColumn === null ? '' : String(panel.colorColumn)}
            ariaLabel={`Panel ${i + 1} color by`}
            onchange={(e) => onPanelColorChange(i, e)}
          >
            <option value="">— same as main —</option>
            {#each columns as col}
              <option value={String(col.index)}>{col.name}</option>
            {/each}
          </Select>
        </div>
      {/each}
    </div>

    <p class="grid-hint">
      Cameras are linked. Hover and lasso work in any panel.
      PNG export includes all panels.
    </p>
  {/if}
</Section>

<style>
  .grid-layout-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }
  .ctrl-label {
    font-size: 11px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    min-width: 48px;
  }
  .grid-panel-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .grid-panel-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .panel-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    min-width: 56px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .grid-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin: 8px 0 2px;
    line-height: 1.4;
  }
</style>
