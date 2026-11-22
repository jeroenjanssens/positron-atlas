<script lang="ts">
  import type { Atlas, LayerState } from '../atlas.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
  import Slider from './Slider.svelte';
  import { DECK_LAYER_IDS } from '../atlas/layers';

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

  // B3: "Add DataFrame..." inline form
  let addingOverlay = $state(false);
  let overlayVariable = $state('');

  function startAddOverlay() {
    addingOverlay = true;
    overlayVariable = '';
  }

  function cancelAddOverlay() {
    addingOverlay = false;
    overlayVariable = '';
  }

  function confirmAddOverlay() {
    const v = overlayVariable.trim();
    if (v) {
      atlas.addOverlay(v);
    }
    addingOverlay = false;
    overlayVariable = '';
  }

  function onOverlayKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') confirmAddOverlay();
    else if (e.key === 'Escape') cancelAddOverlay();
  }
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

      {#if layer.kind === 'point-overlay'}
        <button
          class="remove-btn"
          onclick={() => atlas.removeOverlay(layer.id)}
          aria-label="Remove overlay layer {layer.name}"
          title="Remove overlay"
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      {/if}

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
        {#if DECK_LAYER_IDS.has(layer.id)}
          <Select
            value={layer.blending}
            ariaLabel="Blending"
            onchange={(e) => setBlending(layer, e)}
          >
            <option value="normal">Normal</option>
            <option value="additive">Additive</option>
          </Select>
          <Info id="layers.blending" />
        {:else}
          <span style="display: contents"></span>
          <Info id="layers.visibility" />
        {/if}
      </span>
    </div>
  {/each}

  <!-- B3: Add DataFrame overlay -->
  {#if atlas.phase === 'ready'}
    {#if addingOverlay}
      <div class="add-overlay-form">
        <input
          class="overlay-input"
          type="text"
          placeholder="Variable name (e.g. df2)"
          bind:value={overlayVariable}
          onkeydown={onOverlayKeydown}
          aria-label="Python variable name for overlay DataFrame"
        />
        <button class="add-btn" onclick={confirmAddOverlay} title="Add overlay" disabled={!overlayVariable.trim()}>
          <span class="codicon codicon-check" aria-hidden="true"></span>
        </button>
        <button class="add-btn" onclick={cancelAddOverlay} title="Cancel">
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </div>
    {:else}
      <button class="add-overlay-btn" onclick={startAddOverlay}>
        <span class="codicon codicon-add" aria-hidden="true"></span>
        Add DataFrame…
      </button>
    {/if}
  {/if}
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

  .remove-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    color: var(--vscode-foreground, currentColor);
    flex-shrink: 0;
    margin-left: auto;
    font-size: 11px;
  }

  .remove-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
    color: var(--vscode-errorForeground, #f44);
  }

  .add-overlay-btn {
    all: unset;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #4a9);
    padding: 4px 2px;
    border-radius: 3px;
    margin-top: 2px;
  }

  .add-overlay-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.1));
  }

  .add-overlay-form {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
  }

  .overlay-input {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    padding: 2px 4px;
    border: 1px solid var(--vscode-input-border, #ccc);
    background: var(--vscode-input-background, #fff);
    color: var(--vscode-input-foreground, #000);
    border-radius: 2px;
    outline: none;
  }

  .overlay-input:focus {
    border-color: var(--vscode-focusBorder, #0078d4);
  }

  .add-btn {
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

  .add-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
  }

  .add-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
