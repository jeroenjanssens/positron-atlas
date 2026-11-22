<script lang="ts">
  /**
   * BrushLayer — pointer overlay for the brush tagging tool (B4, item 7).
   *
   * Sits on top of the canvas as a transparent div that captures pointer events
   * whenever the brush tool is active.  Converts CSS-pixel coordinates to world
   * space via atlas.renderer.unproject(), then delegates to atlas.applyBrushStroke().
   * A circular cursor follows the mouse to show the brush footprint.
   *
   * Alt + drag → erase mode (restores atlas.brush.erasing on release).
   * Single click (< 4 px movement) → fill cluster / category (atlas.fillBrushAtPoint).
   */

  import type { Atlas } from '../atlas.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  let el = $state<HTMLDivElement>();
  let cursorX = $state(0);
  let cursorY = $state(0);
  let cursorVisible = $state(false);
  let drawing = $state(false);
  let startX = 0;
  let startY = 0;
  let wasErasing = false;
  let moved = false;

  const active = $derived(atlas.annotateTool === 'brush');

  function local(e: PointerEvent): [number, number] {
    const r = el!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function down(e: PointerEvent) {
    if (e.button !== 0 || !atlas.renderer) return;
    e.preventDefault();
    el!.setPointerCapture(e.pointerId);
    drawing = true;
    moved = false;
    const [sx, sy] = local(e);
    startX = sx;
    startY = sy;
    // Alt → temporary erase mode.
    wasErasing = atlas.brush.erasing;
    if (e.altKey) atlas.brush = { ...atlas.brush, erasing: true };
    // Paint immediately.
    const [wx, wy] = atlas.renderer.unproject(sx, sy);
    atlas.applyBrushStroke(wx, wy);
  }

  function move(e: PointerEvent) {
    if (!el || !atlas.renderer) return;
    const [sx, sy] = local(e);
    cursorX = sx;
    cursorY = sy;
    cursorVisible = true;
    if (!drawing) return;
    const dx = sx - startX;
    const dy = sy - startY;
    if (!moved && Math.hypot(dx, dy) > 4) moved = true;
    const [wx, wy] = atlas.renderer.unproject(sx, sy);
    atlas.applyBrushStroke(wx, wy);
  }

  function up(e: PointerEvent) {
    if (!drawing) return;
    drawing = false;
    // Restore erase mode if it was temporarily set by Alt.
    if (atlas.brush.erasing !== wasErasing) {
      atlas.brush = { ...atlas.brush, erasing: wasErasing };
    }
    // Single-click (no significant drag) → fill cluster / category.
    if (!moved && atlas.renderer && atlas.prepared) {
      const [sx, sy] = local(e);
      const [wx, wy] = atlas.renderer.unproject(sx, sy);
      // Find the closest point to click to fill.
      const xy = atlas.anchorXY;
      const n = atlas.prepared.nAnchors;
      if (xy && n > 0) {
        const wpp = atlas.renderer.worldPerPixel();
        let best = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < n; i++) {
          const dx = xy[2 * i] - wx;
          const dy = xy[2 * i + 1] - wy;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; bestIdx = i; }
        }
        // Only fill when the click is within 2× brush size (screen pixels).
        const r = atlas.brush.sizePx * 2 * wpp;
        if (bestIdx >= 0 && best <= r * r) {
          atlas.fillBrushAtPoint(bestIdx);
        }
      }
    }
  }

  function leave() {
    cursorVisible = false;
  }
</script>

{#if active}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="brush-layer"
    bind:this={el}
    role="application"
    aria-label="Brush tool: drag to paint, Alt+drag to erase"
    style:cursor="none"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={() => { drawing = false; cursorVisible = false; }}
    onpointerleave={leave}
  >
    {#if cursorVisible}
      <!-- Brush cursor circle (CSS pixels). -->
      <svg class="brush-cursor" style="left:{cursorX - atlas.brush.sizePx}px; top:{cursorY - atlas.brush.sizePx}px; width:{atlas.brush.sizePx * 2}px; height:{atlas.brush.sizePx * 2}px;" aria-hidden="true">
        <circle cx={atlas.brush.sizePx} cy={atlas.brush.sizePx} r={atlas.brush.sizePx - 1}
          fill="none"
          stroke={atlas.brush.erasing ? 'rgba(255,100,100,0.9)' : 'rgba(255,255,255,0.9)'}
          stroke-width="1.5"
          stroke-dasharray={atlas.brush.erasing ? '3 2' : 'none'}
        />
      </svg>
    {/if}
  </div>
{/if}

<style>
  .brush-layer {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: all;
    user-select: none;
  }
  .brush-cursor {
    position: absolute;
    pointer-events: none;
  }
</style>
