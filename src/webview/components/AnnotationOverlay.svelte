<script lang="ts">
  /**
   * AnnotationOverlay: HTML callout boxes + SVG leader lines for point annotations (A4).
   *
   * Positioning: a requestAnimationFrame loop projects each annotation's world coordinates
   * to CSS-pixel screen coordinates each frame, so callouts stay attached to points
   * during pan/zoom.
   *
   * Drag: mousedown on the callout box starts a drag; mousemove updates offsetX/offsetY.
   * Double-click on the text area enters edit mode.
   */
  import { onMount } from 'svelte';
  import type { Atlas } from '../atlas.svelte';
  import type { AnnotationData } from '../../shared/protocol';
  import PixelImage from './PixelImage.svelte';
  import { resolveInvert } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  // Screen positions of each annotation anchor point (the annotated dot).
  // Keyed by annotation id.
  let positions = $state<Map<string, [number, number]>>(new Map());

  let rafId = 0;

  function updatePositions() {
    if (!atlas.renderer) return;
    const next = new Map<string, [number, number]>();
    for (const ann of atlas.annotations.values()) {
      const pt = atlas.renderer.projectWorld(ann.worldX, ann.worldY);
      if (pt) next.set(ann.id, pt);
    }
    positions = next;
    rafId = requestAnimationFrame(updatePositions);
  }

  onMount(() => {
    rafId = requestAnimationFrame(updatePositions);
    return () => cancelAnimationFrame(rafId);
  });

  // Editing state
  let editingId = $state<string | null>(null);
  let editText = $state('');

  // Drag state
  let dragId: string | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let origOffsetX = 0;
  let origOffsetY = 0;
  let isDragging = false;

  function onBoxMouseDown(e: MouseEvent, ann: AnnotationData) {
    if (e.button !== 0) return;
    // Don't start drag when editing text.
    if (editingId === ann.id) return;
    e.preventDefault();
    e.stopPropagation();
    dragId = ann.id;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    origOffsetX = ann.offsetX;
    origOffsetY = ann.offsetY;
    isDragging = false;
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!dragId) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) isDragging = true;
    if (isDragging) {
      atlas.updateAnnotationOffset(dragId, origOffsetX + dx, origOffsetY + dy);
    }
  }

  function onWindowMouseUp(e: MouseEvent) {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
    dragId = null;
    isDragging = false;
  }

  function onBoxDblClick(ann: AnnotationData) {
    if (ann.style === 'image') return;
    editingId = ann.id;
    editText = ann.text;
  }

  function commitEdit(ann: AnnotationData) {
    if (editingId === ann.id) {
      atlas.updateAnnotationText(ann.id, editText);
      editingId = null;
    }
  }

  function onEditKeyDown(e: KeyboardEvent, ann: AnnotationData) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitEdit(ann);
    }
    if (e.key === 'Escape') {
      editingId = null;
    }
  }

  // Build the CSS position for the callout box from anchor + offset.
  function boxPos(ann: AnnotationData): { left: string; top: string } | null {
    const pt = positions.get(ann.id);
    if (!pt) return null;
    return {
      left: `${pt[0] + ann.offsetX}px`,
      top: `${pt[1] + ann.offsetY}px`,
    };
  }

  // Leader line endpoints: from screen anchor to box center (approximate).
  function leaderLine(ann: AnnotationData): { x1: number; y1: number; x2: number; y2: number } | null {
    const pt = positions.get(ann.id);
    if (!pt) return null;
    // Box center estimate: 60px wide, 28px tall (approximate).
    const bx = pt[0] + ann.offsetX + 40;
    const by = pt[1] + ann.offsetY + 14;
    return { x1: pt[0], y1: pt[1], x2: bx, y2: by };
  }

  const annotationList = $derived([...atlas.annotations.values()]);
</script>

<!-- SVG layer for leader lines (below callout boxes) -->
{#if annotationList.length}
  <svg class="leader-svg" aria-hidden="true">
    {#each annotationList as ann (ann.id)}
      {@const ll = leaderLine(ann)}
      {#if ll}
        <line
          x1={ll.x1} y1={ll.y1}
          x2={ll.x2} y2={ll.y2}
          class="leader"
          stroke={ann.style === 'badge' && ann.color ? ann.color : 'var(--vscode-editor-foreground, #ccc)'}
          stroke-opacity="0.8"
          stroke-width="1.5"
          stroke-dasharray="4 3"
        />
        <circle cx={ll.x1} cy={ll.y1} r="3"
          fill={ann.style === 'badge' && ann.color ? ann.color : 'var(--vscode-editor-foreground, #ccc)'}
          opacity="0.9" />
      {/if}
    {/each}
  </svg>

  <!-- Callout boxes -->
  {#each annotationList as ann (ann.id)}
    {@const bp = boxPos(ann)}
    {#if bp}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="callout"
        class:badge={ann.style === 'badge'}
        class:draggable={editingId !== ann.id}
        style="left:{bp.left}; top:{bp.top}; {ann.style === 'badge' && ann.color ? `--badge-color: ${ann.color};` : ''}"
        role="note"
        aria-label="Annotation: {ann.style === 'image' ? 'Image row ' + ann.row : (ann.text || 'Row ' + ann.row)}"
        onmousedown={(e) => onBoxMouseDown(e, ann)}
        ondblclick={() => onBoxDblClick(ann)}
      >
        {#if ann.style === 'image'}
          {#if ann.imagePixels && ann.imageShape}
            <PixelImage
              values={ann.imagePixels}
              width={ann.imageShape[0]}
              height={ann.imageShape[1]}
              invert={resolveInvert(atlas.view.imageInvert)}
              size={64}
            />
            {#if ann.text && ann.text !== `Row ${ann.row}`}
              <div class="ann-img-caption">{ann.text}</div>
            {/if}
          {:else if ann.imageDataUrl}
            <img src={ann.imageDataUrl} alt="Row {ann.row}" class="ann-url-img" class:invert-on={atlas.view.imageInvert === true} class:invert-auto={atlas.view.imageInvert === 'auto'} />
          {:else}
            <!-- Pixel data not yet loaded; show row number while waiting -->
            <div class="ann-image-placeholder" title="Row {ann.row}">Row {ann.row}</div>
          {/if}
        {:else if editingId === ann.id}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="ann-edit"
            bind:value={editText}
            rows="2"
            onblur={() => commitEdit(ann)}
            onkeydown={(e) => onEditKeyDown(e, ann)}
            autofocus
          ></textarea>
        {:else}
          <div class="ann-text">{ann.text}</div>
        {/if}
        <button
          class="ann-remove icon-btn"
          title="Remove annotation"
          aria-label="Remove annotation for row {ann.row}"
          onclick={(e) => { e.stopPropagation(); atlas.removeAnnotation(ann.id); }}
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </div>
    {/if}
  {/each}
{/if}

<style>
  .leader-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 6;
    overflow: visible;
  }
  .callout {
    position: absolute;
    z-index: 7;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    color: var(--vscode-editor-foreground, #cccccc);
    border-radius: 4px;
    padding: 4px 24px 4px 8px;
    max-width: 200px;
    min-width: 60px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    font-size: 0.85em;
    line-height: 1.3;
    cursor: grab;
    user-select: none;
  }
  .callout:active { cursor: grabbing; }
  .callout.badge {
    background: color-mix(in srgb, var(--badge-color, #555) 25%, var(--vscode-editorWidget-background, #252526));
    border-color: var(--badge-color, #555);
  }
  .ann-text {
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 180px;
  }
  .ann-edit {
    background: transparent;
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    color: inherit;
    font: inherit;
    resize: none;
    width: 160px;
    outline: none;
    border-radius: 2px;
    padding: 1px 3px;
  }
  .ann-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-icon-foreground, #c5c5c5);
    padding: 0;
    display: flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.1s;
    line-height: 1;
  }
  .callout:hover .ann-remove { opacity: 1; }
  .ann-remove .codicon { font-size: 12px; }
  .ann-image-placeholder {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground, #aaa);
    padding: 2px 0;
  }
  .ann-img-caption {
    font-size: 0.75em;
    color: var(--vscode-descriptionForeground, #aaa);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 80px;
  }
  .ann-url-img {
    display: block;
    max-width: 64px;
    max-height: 64px;
    object-fit: contain;
    image-rendering: pixelated;
  }
</style>
