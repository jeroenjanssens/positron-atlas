<script lang="ts">
  /**
   * A12 — Glow overlay.
   *
   * Renders a canvas with the blurred per-cluster density halo and composites
   * it over deck.gl (z-index: 2) using normal alpha compositing.  Re-renders
   * whenever atlas.glowVersion increments (driven by view changes and data
   * updates).
   */
  import { onMount } from 'svelte';
  import type { Atlas } from '../atlas.svelte';
  import { renderGlow } from '../atlas/glow';

  let { atlas }: { atlas: Atlas } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>(undefined);
  let container: HTMLDivElement;

  // Track which glowVersion we last rendered.
  let lastVersion = -1;

  $effect(() => {
    // Reactive: re-render whenever glowVersion changes.
    const version = atlas.glowVersion;
    const enabled = atlas.view.glow;
    if (!enabled || canvas === undefined) return;
    if (version === lastVersion) return;
    lastVersion = version;
    renderGlowNow();
  });

  function renderGlowNow() {
    if (!canvas || canvas === undefined || !atlas.renderer) return;
    const rect = container?.getBoundingClientRect();
    const viewW = rect?.width || 800;
    const viewH = rect?.height || 600;

    const anchorXY = atlas.anchorXY;
    const nAnchors = atlas.prepared?.nAnchors ?? 0;
    if (!anchorXY || nAnchors === 0) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // Use the per-anchor RGBA color array for best fidelity (works with all color modes).
    // Falls back to grey if colors aren't loaded yet.
    const rgbaPerPoint = atlas.colorsAnchors ?? null;

    renderGlow(
      canvas,
      anchorXY,
      nAnchors,
      null,
      [],
      (wx, wy) => atlas.renderer!.projectWorld(wx, wy),
      atlas.view.glowStrength ?? 0.4,
      atlas.view.glowRadius ?? 40,
      viewW,
      viewH,
      rgbaPerPoint,
    );
  }

  onMount(() => {
    // Initial render.
    renderGlowNow();
  });
</script>

<!-- z-index: 2 places the glow above the deck.gl canvas (z-index: auto) so it is
     always visible.  Pointer events are disabled; opacity/blend modes are handled
     by the canvas rendering itself (globalAlpha = strength). -->
<div class="glow-container" bind:this={container} aria-hidden="true">
  {#if atlas.view.glow}
    <canvas bind:this={canvas} class="glow-canvas" aria-hidden="true"></canvas>
  {/if}
</div>

<style>
  .glow-container {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 2;
  }
  .glow-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
</style>
