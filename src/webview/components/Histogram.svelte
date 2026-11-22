<script lang="ts">
  /**
   * A small histogram with a drag-to-brush range selector for A13.
   * Uses SVG; bins and edges come from atlas.histData.
   */
  import type { Atlas } from '../atlas.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  const W = 240;
  const H = 56;
  const PAD_L = 2;
  const PAD_R = 2;
  const PAD_T = 4;
  const PAD_B = 16;
  const IW = W - PAD_L - PAD_R;
  const IH = H - PAD_T - PAD_B;

  const data = $derived(atlas.histData);
  const filter = $derived(atlas.histFilter);

  const maxCount = $derived(data ? Math.max(1, ...data.counts) : 1);
  const edges = $derived(data?.edges ?? [0, 1]);
  const lo = $derived(edges[0]);
  const hi = $derived(edges[edges.length - 1]);
  const span = $derived(hi > lo ? hi - lo : 1);

  function toPixel(v: number): number {
    return PAD_L + ((v - lo) / span) * IW;
  }

  function fromPixel(px: number): number {
    return lo + ((px - PAD_L) / IW) * span;
  }

  const rects = $derived(
    data
      ? data.counts.map((count, i) => {
          const x = toPixel(edges[i]);
          const x2 = toPixel(edges[i + 1]);
          const h = (count / maxCount) * IH;
          return { x, w: Math.max(0.5, x2 - x - 0.5), y: PAD_T + IH - h, h };
        })
      : []
  );

  const [rangeLoX, rangeHiX] = $derived.by(() => {
    if (!filter) return [PAD_L, PAD_L + IW];
    return [toPixel(filter.range[0]), toPixel(filter.range[1])];
  });

  // Label values for the brush handles.
  const loLabel = $derived(filter ? formatLabel(filter.range[0], data?.isDatetime ?? false) : '');
  const hiLabel = $derived(filter ? formatLabel(filter.range[1], data?.isDatetime ?? false) : '');

  function formatLabel(v: number, isDate: boolean): string {
    if (isDate) {
      const d = new Date(v);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) {
      return v.toExponential(2);
    }
    return v.toPrecision(3).replace(/\.?0+$/, '');
  }

  // Drag state (reactive so cursor updates).
  let dragging = $state<'lo' | 'hi' | 'brush' | null>(null);
  let dragStart = $state(0);
  let dragRangeLo = $state(0);
  let dragRangeHi = $state(0);

  function svgX(e: MouseEvent | TouchEvent): number {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect?.() ??
      (e.target as SVGElement).ownerSVGElement!.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    return ((clientX - rect.left) / rect.width) * W;
  }

  function clampRange(v: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  function onMouseDown(e: MouseEvent, handle: 'lo' | 'hi' | 'brush'): void {
    e.preventDefault();
    dragging = handle;
    dragStart = svgX(e);
    dragRangeLo = filter?.range[0] ?? lo;
    dragRangeHi = filter?.range[1] ?? hi;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging || !filter) return;
    const x = fromPixel(svgX(e));
    const dx = x - fromPixel(dragStart);
    if (dragging === 'lo') {
      atlas.setHistRange([clampRange(dragRangeLo + dx), filter.range[1]]);
    } else if (dragging === 'hi') {
      atlas.setHistRange([filter.range[0], clampRange(dragRangeHi + dx)]);
    } else {
      const newLo = clampRange(dragRangeLo + dx);
      const newHi = clampRange(dragRangeHi + dx);
      atlas.setHistRange([newLo, newHi]);
    }
  }

  function onMouseUp(): void {
    dragging = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  function onResetBrush(): void {
    atlas.setHistRange([lo, hi]);
  }
</script>

<div class="hist-wrap">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    viewBox="0 0 {W} {H}"
    width="100%"
    role="img"
    aria-label="Histogram brush filter"
    style="display:block; cursor: {dragging ? 'ew-resize' : 'default'}"
    onmousedown={(e) => { if (e.button === 0) onMouseDown(e, 'brush'); }}
  >
    <!-- Bars -->
    {#each rects as r (r.x)}
      <rect x={r.x} y={r.y} width={r.w} height={r.h} class="bar" />
    {/each}

    <!-- Brush overlay -->
    {#if filter}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <rect
        role="presentation"
        x={rangeLoX} y={PAD_T}
        width={Math.max(0, rangeHiX - rangeLoX)} height={IH}
        class="brush-fill"
        onmousedown={(e) => { e.stopPropagation(); onMouseDown(e, 'brush'); }}
      />
      <!-- Lo handle -->
      <line x1={rangeLoX} y1={PAD_T} x2={rangeLoX} y2={PAD_T + IH} class="handle" />
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <rect
        role="presentation"
        x={rangeLoX - 4} y={PAD_T} width={8} height={IH}
        fill="transparent"
        style="cursor:ew-resize"
        onmousedown={(e) => { e.stopPropagation(); onMouseDown(e, 'lo'); }}
      />
      <!-- Hi handle -->
      <line x1={rangeHiX} y1={PAD_T} x2={rangeHiX} y2={PAD_T + IH} class="handle" />
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <rect
        role="presentation"
        x={rangeHiX - 4} y={PAD_T} width={8} height={IH}
        fill="transparent"
        style="cursor:ew-resize"
        onmousedown={(e) => { e.stopPropagation(); onMouseDown(e, 'hi'); }}
      />
      <!-- Labels -->
      <text x={rangeLoX} y={H - 2} class="label label-lo">{loLabel}</text>
      <text x={rangeHiX} y={H - 2} class="label label-hi">{hiLabel}</text>
    {/if}

    <!-- Axes baseline -->
    <line x1={PAD_L} y1={PAD_T + IH} x2={PAD_L + IW} y2={PAD_T + IH} class="axis" />
  </svg>
  {#if filter && (filter.range[0] > lo || filter.range[1] < hi)}
    <button class="link reset" onclick={onResetBrush} title="Reset brush to show all">Reset</button>
  {/if}
</div>

<style>
  .hist-wrap {
    position: relative;
    margin: 4px 0;
  }
  .bar {
    fill: var(--vscode-charts-blue, #4e79a7);
    opacity: 0.6;
  }
  .brush-fill {
    fill: var(--vscode-editor-selectionBackground, rgba(78,121,167,0.2));
    cursor: ew-resize;
  }
  .handle {
    stroke: var(--vscode-focusBorder, #0078d4);
    stroke-width: 1.5;
  }
  .axis {
    stroke: var(--vscode-editorWidget-border, #aaa);
    stroke-width: 0.5;
  }
  .label {
    font-size: 8px;
    fill: var(--vscode-editor-foreground, #333);
  }
  .label-lo {
    text-anchor: start;
  }
  .label-hi {
    text-anchor: end;
  }
  .reset {
    position: absolute;
    right: 0;
    top: 0;
    font-size: 10px;
    padding: 1px 4px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-textLink-foreground, #0078d4);
  }
  .reset:hover {
    text-decoration: underline;
  }
</style>
