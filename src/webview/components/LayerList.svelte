<script lang="ts">
  import type { Atlas, LayerState } from '../atlas.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
  import Slider from './Slider.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  /** Layers sorted by draw order (lowest order = bottom of stack). */
  const sortedLayers = $derived([...atlas.layers].sort((a, b) => a.order - b.order));

  function toggleVisible(layer: LayerState) {
    atlas.updateLayer(layer.id, { visible: !layer.visible });
  }

  function setOpacity(layer: LayerState, v: number) {
    atlas.updateLayer(layer.id, { opacity: v });
  }

  function setBlending(layer: LayerState, e: Event) {
    const v = (e.target as HTMLSelectElement).value as 'normal' | 'additive';
    atlas.updateLayer(layer.id, { blending: v });
  }

  // Drag-to-reorder state
  let dragId = $state<string | null>(null);

  function onDragStart(e: DragEvent, id: string) {
    dragId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  function onDragOver(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const targetIdx = sortedLayers.findIndex((l) => l.id === targetId);
    if (targetIdx >= 0) atlas.reorderLayer(dragId, targetIdx);
    dragId = null;
  }

  function onDragEnd() { dragId = null; }
</script>

<div class="layer-list">
  {#each sortedLayers as layer (layer.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="layer-row"
      class:dragging={dragId === layer.id}
      draggable="true"
      ondragstart={(e) => onDragStart(e, layer.id)}
      ondragover={(e) => onDragOver(e, layer.id)}
      ondrop={(e) => onDrop(e, layer.id)}
      ondragend={onDragEnd}
    >
      <span class="drag-handle codicon codicon-grabber" aria-hidden="true"></span>

      <button
        class="eye-btn"
        onclick={() => toggleVisible(layer)}
        aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
        title={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
      >
        <span
          class="codicon {layer.visible ? 'codicon-eye' : 'codicon-eye-closed'}"
          aria-hidden="true"
        ></span>
      </button>

      <span class="layer-name" title={layer.name}>{layer.name}</span>

      {#if layer.kind === 'base' || layer.kind === 'overlay-frame'}
        <span class="layer-controls">
          <span class="opacity-wrap">
            <Slider
              label="Opacity"
              value={layer.opacity}
              min={0}
              max={1}
              step={0.01}
              tag="live"
              infoId="layers.opacity"
              onchange={(v) => setOpacity(layer, v)}
            />
          </span>
          <Select
            value={layer.blending}
            ariaLabel="Blending"
            onchange={(e) => setBlending(layer, e)}
          >
            <option value="normal">Normal</option>
            <option value="additive">Additive</option>
          </Select>
          <Info id="layers.blending" />
        </span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .layer-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .layer-row {
    display: grid;
    grid-template-columns: 14px 20px 1fr;
    align-items: start;
    gap: 4px;
    padding: 4px 0;
    border-radius: 4px;
    cursor: default;
  }

  .layer-row.dragging {
    opacity: 0.4;
  }

  .drag-handle {
    cursor: grab;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 12px;
    line-height: 20px;
    user-select: none;
  }

  .eye-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 3px;
    color: var(--vscode-foreground, currentColor);
    flex-shrink: 0;
  }

  .eye-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
  }

  .layer-name {
    font-size: 12px;
    line-height: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .layer-controls {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 4px;
    padding-left: 34px;
  }

  .opacity-wrap {
    min-width: 0;
  }
</style>
