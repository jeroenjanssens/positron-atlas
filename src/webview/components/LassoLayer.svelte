<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import type { SelectMode } from '../select/lasso';

  let { atlas }: { atlas: Atlas } = $props();

  let el = $state<SVGSVGElement>();
  let points = $state<[number, number][]>([]);
  let drawing = $state(false);
  let mode = $state<SelectMode>('replace');
  // Shift or Alt held: the lasso is available with the pan tool too.
  let modifier = $state(false);
  const active = $derived(atlas.tool === 'lasso' || modifier || drawing);

  function onKey(e: KeyboardEvent) {
    modifier = e.shiftKey || e.altKey;
    if (e.type === 'keydown' && e.key === 'Escape') {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (drawing) {
        drawing = false;
        points = [];
        atlas.setLassoBounds(null);
      } else {
        atlas.clearSelection();
      }
    }
  }

  function local(e: PointerEvent): [number, number] {
    const r = el!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    el!.setPointerCapture(e.pointerId);
    mode = e.altKey ? 'remove' : e.shiftKey ? 'add' : 'replace';
    drawing = true;
    points = [local(e)];
  }

  function move(e: PointerEvent) {
    if (!drawing) return;
    const p = local(e);
    const last = points[points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 3) {
      points = [...points, p];
      // B2: update live lasso bounding-box overlay.
      if (points.length >= 2 && atlas.dims !== 3) atlas.setLassoBounds(points);
    }
  }

  function up() {
    if (!drawing) return;
    drawing = false;
    atlas.setLassoBounds(null); // remove preview box
    if (points.length >= 3) atlas.applyLasso(points, mode);
    points = [];
  }
</script>

<svelte:window onkeydown={onKey} onkeyup={onKey} onblur={() => (modifier = false)} />

{#if active}
  <svg
    bind:this={el}
    class="lasso-layer"
    class:remove={mode === 'remove' && drawing}
    role="application"
    aria-label="Lasso selection: drag around points to select them"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={() => { drawing = false; points = []; atlas.setLassoBounds(null); }}
  >
    {#if points.length > 1}
      <polygon points={points.map((p) => p.join(',')).join(' ')} />
    {/if}
  </svg>
{/if}
