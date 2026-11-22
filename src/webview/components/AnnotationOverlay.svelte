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
  import { getLayer, htmlOverlayZIndex } from '../atlas/layers';

  let { atlas }: { atlas: Atlas } = $props();

  /**
   * Per-annotation screen positions, updated every frame by the RAF loop.
   * anchor = screen pos of the annotated point; box = screen pos of the callout box top-left.
   * Storing BOTH in $state ensures Svelte re-renders with current viewport on every frame,
   * including after pan, zoom and rotation (B5).
   */
  interface AnnPos { anchor: [number, number]; box: [number, number] }
  let positions = $state<Map<string, AnnPos>>(new Map());

  let rafId = 0;

  function updatePositions() {
    if (!atlas.renderer) return;
    const next = new Map<string, AnnPos>();
    for (const ann of atlas.annotations.values()) {
      // B5: anchor and box positions derived from world coordinates each frame.
      const anchor = atlas.renderer.projectWorld(ann.worldX, ann.worldY, ann.worldZ ?? 0);
      if (!anchor) continue;
      const box = atlas.renderer.projectWorld(ann.worldX + ann.offsetX, ann.worldY + ann.offsetY, ann.worldZ ?? 0) ?? anchor;
      next.set(ann.id, { anchor, box });
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

  // Drag state (B5: accumulate world-coordinate deltas)
  let dragId: string | null = null;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragStartCanvasX = 0; // canvas-relative start (for renderer.screenDeltaToWorld)
  let dragStartCanvasY = 0;
  let dragWorldZ: number | undefined; // worldZ of the annotation being dragged (for 3D depth-correct drag)
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
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    origOffsetX = ann.offsetX;
    origOffsetY = ann.offsetY;
    dragWorldZ = ann.worldZ; // B5: used for depth-correct unproject in 3D
    isDragging = false;
    // Record canvas-relative start position for world-delta computation.
    const canvas = document.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect();
    dragStartCanvasX = rect ? e.clientX - rect.left : e.clientX;
    dragStartCanvasY = rect ? e.clientY - rect.top : e.clientY;
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!dragId || !atlas.renderer) return;
    const dx = e.clientX - dragStartClientX;
    const dy = e.clientY - dragStartClientY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) isDragging = true;
    if (isDragging) {
      // Convert screen-pixel delta to world delta (B5: map-coordinate offsets).
      // In 3D: pass dragWorldZ for depth-correct unproject at the annotation's depth plane.
      const worldDelta = atlas.renderer.screenDeltaToWorld(
        dragStartCanvasX, dragStartCanvasY, dx, dy, dragWorldZ,
      );
      atlas.updateAnnotationOffset(dragId, origOffsetX + worldDelta[0], origOffsetY + worldDelta[1]);
    }
  }

  function onWindowMouseUp() {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
    if (isDragging && dragId) {
      const id = dragId;
      const beforeX = origOffsetX;
      const beforeY = origOffsetY;
      const ann = atlas.annotations.get(id);
      if (ann) {
        const afterX = ann.offsetX;
        const afterY = ann.offsetY;
        atlas.recordHistory({
          label: 'Move annotation',
          undo: () => atlas.updateAnnotationOffset(id, beforeX, beforeY),
          redo: () => atlas.updateAnnotationOffset(id, afterX, afterY),
          coalesceKey: `ann-drag:${id}`,
        });
      }
    }
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

  /**
   * Depth fade: in 3D, boxes whose anchor is "behind" the data cloud (depth > 0.5)
   * are faded to show they're occluded. Returns 1 (fully opaque) in 2D.
   * Reads from cached positions (updated every RAF frame via $state).
   */
  function depthOpacity(ann: AnnotationData): number {
    if (!atlas.renderer || atlas.dims !== 3 || !ann.worldZ) return 1;
    const depth = atlas.renderer.projectWorldDepth(ann.worldX, ann.worldY, ann.worldZ);
    // depth in [0,1]; > 0.5 is behind; we fade linearly from 1 at 0.4 to 0.2 at 0.9.
    if (depth <= 0.4) return 1;
    if (depth >= 0.9) return 0.2;
    return 1 - 0.8 * (depth - 0.4) / 0.5;
  }

  /**
   * Off-screen fade: returns 0 when the annotated point is well outside the canvas.
   * Reads anchor from positions ($state), so this expression is reactive.
   */
  function offScreenOpacity(ann: AnnotationData): number {
    if (!atlas.renderer) return 1;
    const { width: W, height: H } = atlas.renderer.canvasSize;
    const pos = positions.get(ann.id);
    if (!pos) return 0;
    const [ax, ay] = pos.anchor;
    const margin = 60;
    if (ax < -margin || ax > W + margin || ay < -margin || ay > H + margin) return 0;
    return 1;
  }

  const annotationList = $derived([...atlas.annotations.values()]);

  // A2: layer visibility, opacity and z-index from the registry.
  const annLayer = $derived(getLayer(atlas.layers, 'annotations'));
  const annVisible = $derived(annLayer?.visible ?? true);
  const annOpacity = $derived(annLayer?.opacity ?? 1);
  const calloutZIndex = $derived(htmlOverlayZIndex(atlas.layers, 'annotations'));
</script>

<!-- Callout boxes (A2: z-index and opacity from layer registry).
     Leader lines are drawn as a deck.gl LineLayer in map space (leaderLines.ts, B5)
     so they orbit and depth-sort correctly in both 2D and 3D. -->
{#if annotationList.length && annVisible}
  {#each annotationList as ann (ann.id)}
    {@const pos = positions.get(ann.id)}
    {#if pos}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="callout"
        class:badge={ann.style === 'badge'}
        class:draggable={editingId !== ann.id}
        style="left:{pos.box[0]}px; top:{pos.box[1]}px; z-index:{calloutZIndex}; opacity:{annOpacity * depthOpacity(ann) * offScreenOpacity(ann)}; {ann.style === 'badge' && ann.color ? `--badge-color: ${ann.color};` : ''}"
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
  .callout {
    position: absolute;
    /* z-index set inline via layer registry */
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
