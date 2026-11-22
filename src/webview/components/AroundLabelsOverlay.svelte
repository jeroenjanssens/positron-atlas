<script lang="ts">
  /**
   * A11 — Around-the-map labels: HTML label elements + SVG leader lines.
   *
   * Runs a requestAnimationFrame loop that re-projects the world-space anchor
   * positions to screen coordinates on every frame, so labels and leaders track
   * the view during pan and zoom.  The overlap-removal pass runs at most once
   * per rAF tick (it is O(k²) for k groups, typically ≤ 50, so it is fast).
   *
   * Drag offsets use the same `atlas.setDragOffset(key, offset)` API as the
   * deck.gl label drag (A3), so saved positions are shared between 'over' and
   * 'around' modes.
   */
  import { onMount } from 'svelte';
  import type { Atlas } from '../atlas.svelte';
  import { computeAroundLabels } from '../labels/around';
  import type { AroundLabel } from '../labels/around';
  import { getLayer, htmlOverlayZIndex } from '../atlas/layers';

  let { atlas }: { atlas: Atlas } = $props();

  let container: HTMLDivElement;
  let svgEl: SVGSVGElement;
  let rafId = 0;

  // Recomputed every rAF tick.
  let rendered = $state<AroundLabel[]>([]);

  // Drag state (mirrors A3 drag for 'over' labels).
  let dragKey: string | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let origOffsetX = 0;
  let origOffsetY = 0;
  let isDragging = false;
  let beforeDragOffsets: Record<string, [number, number]> = {};

  function tick() {
    const groups = atlas.aroundLabelGroups;
    if (!groups || !groups.length || !atlas.renderer || !container) {
      rendered = [];
      rafId = requestAnimationFrame(tick);
      return;
    }

    const rect = container.getBoundingClientRect();
    const viewW = rect.width || atlas.renderer['container']?.clientWidth || 800;
    const viewH = rect.height || atlas.renderer['container']?.clientHeight || 600;

    const opts = atlas.labels;
    const dragOffsets = opts.dragOffsets ?? {};

    // Apply stored drag offsets to the world positions.
    const groupsWithOffsets = groups.map(g => {
      const off = dragOffsets[g.key];
      return off ? { ...g, worldX: g.worldX, worldY: g.worldY, _screenOffX: off[0], _screenOffY: off[1] } : g;
    });

    const result = computeAroundLabels(
      groupsWithOffsets,
      (wx, wy) => atlas.renderer!.projectWorld(wx, wy),
      viewW,
      viewH,
      {
        leaderStyle: opts.leaderStyle ?? 'straight',
        leaderColor: opts.leaderColor ?? 'cluster',
        fitTopPx: 76,
        legendWidth: atlas.legendWidth(),
      },
      // Pass all anchor positions for accurate per-angle cloud-boundary radius.
      atlas.anchorXY ?? undefined,
      atlas.nAnchors,
    );

    // Apply drag offsets to the computed screen positions.
    rendered = result.map(al => {
      const off = dragOffsets[al.key];
      if (off) {
        return { ...al, screenX: al.screenX + off[0], screenY: al.screenY + off[1] };
      }
      return al;
    });

    rafId = requestAnimationFrame(tick);
  }

  onMount(() => {
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
    };
  });

  function onLabelMouseDown(e: MouseEvent, al: AroundLabel) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragKey = al.key;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const existing = atlas.labels.dragOffsets?.[al.key] ?? [0, 0];
    origOffsetX = existing[0];
    origOffsetY = existing[1];
    beforeDragOffsets = { ...(atlas.labels.dragOffsets ?? {}) };
    isDragging = false;
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
  }

  function onWindowMove(e: MouseEvent) {
    if (!dragKey) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) isDragging = true;
    if (isDragging) {
      atlas.setDragOffset(dragKey, [origOffsetX + dx, origOffsetY + dy]);
    }
  }

  function onWindowUp() {
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup', onWindowUp);
    if (isDragging && dragKey) {
      const key = dragKey;
      const before = { ...beforeDragOffsets };
      const after = { ...(atlas.labels.dragOffsets ?? {}) };
      atlas.recordHistory({
        label: `Move label "${key}"`,
        undo: () => { atlas.labels = { ...atlas.labels, dragOffsets: before }; atlas.updateLabels(); },
        redo: () => { atlas.labels = { ...atlas.labels, dragOffsets: after }; atlas.updateLabels(); },
        coalesceKey: `around-drag:${key}`,
      });
    }
    dragKey = null;
    isDragging = false;
  }

  function colorStr(c: [number, number, number, number]): string {
    return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;
  }

  function leaderStroke(al: AroundLabel): string {
    if ((atlas.labels.leaderColor ?? 'cluster') === 'grey') return 'rgba(170,170,170,0.85)';
    return al.clusterColor ? al.clusterColor + 'cc' : 'rgba(170,170,170,0.85)';
  }

  const leaderW = $derived(atlas.labels.leaderWidth ?? 1.5);
  const isWedge = $derived((atlas.labels.leaderStyle ?? 'straight') === 'wedge');

  // A2: layer visibility, opacity and z-index from the registry.
  const aroundLayer = $derived(getLayer(atlas.layers, 'around-labels'));
  const aroundVisible = $derived(aroundLayer?.visible ?? true);
  const aroundOpacity = $derived(aroundLayer?.opacity ?? 1);
  const aroundZIndex = $derived(htmlOverlayZIndex(atlas.layers, 'around-labels'));
</script>

<!-- Overlay container: fills the plot area, pointer-events none except on labels.
     A2: visibility, opacity and z-index from layer registry. -->
<div class="around-overlay" bind:this={container} aria-hidden="true"
  style="z-index: {aroundZIndex}; opacity: {aroundOpacity}; {!aroundVisible ? 'display: none;' : ''}"
>
  <!-- SVG leader lines (below labels) -->
  <svg class="leader-svg" bind:this={svgEl}>
    {#each rendered as al (al.key)}
      {#if isWedge}
        <path
          d={al.leaderPath}
          fill={leaderStroke(al)}
          stroke="none"
          opacity="0.85"
        />
      {:else}
        <path
          d={al.leaderPath}
          fill="none"
          stroke={leaderStroke(al)}
          stroke-width={leaderW}
          stroke-linecap="round"
          opacity="0.85"
        />
        <!-- Anchor dot -->
        <circle
          cx={al.anchorX} cy={al.anchorY} r={leaderW * 1.4}
          fill={leaderStroke(al)}
          opacity="0.9"
        />
      {/if}
    {/each}
  </svg>

  <!-- HTML label elements (above SVG) -->
  {#each rendered as al (al.key)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="around-label"
      class:has-badge={!!al.badge}
      style="
        left: {al.screenX}px;
        top: {al.screenY}px;
        font-size: {al.size}px;
        font-weight: {al.weight ?? 600};
        color: {al.badge ? '#ffffff' : colorStr(al.color)};
        {al.badge ? `background: rgba(${al.badge[0]},${al.badge[1]},${al.badge[2]},${(al.badge[3]/255).toFixed(2)});` : ''}
      "
      onmousedown={(e) => onLabelMouseDown(e, al)}
      title={al.text}
      role="note"
      aria-label="Label: {al.text}"
    >
      {al.text}
    </div>
  {/each}
</div>

<style>
  .around-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* z-index set inline via layer registry */
    overflow: visible;
  }
  .leader-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .around-label {
    position: absolute;
    transform: translate(-50%, -50%);
    white-space: nowrap;
    cursor: grab;
    pointer-events: auto;
    user-select: none;
    text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7);
    padding: 1px 4px;
    border-radius: 3px;
    line-height: 1.2;
  }
  .around-label.has-badge {
    text-shadow: none;
    padding: 2px 6px;
    border-radius: 999px;
  }
  .around-label:active {
    cursor: grabbing;
  }
</style>
