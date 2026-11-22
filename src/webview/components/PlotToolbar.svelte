<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();

  // Fullscreen state
  let fullscreen = $state(false);

  function toggleFullscreen() {
    if (atlas.isPositron) {
      // In Positron: post a ToHost message; the host runs the maximize command.
      fullscreen = !fullscreen;
      atlas.setFullscreen(fullscreen);
    } else {
      // In a plain browser: use the Fullscreen API.
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => { fullscreen = true; }).catch(() => {});
      } else {
        document.exitFullscreen().then(() => { fullscreen = false; }).catch(() => {});
      }
    }
  }

  // Keep local state in sync with browser fullscreen change events.
  function onFullscreenChange() {
    if (!atlas.isPositron) {
      fullscreen = !!document.fullscreenElement;
    }
  }
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- Plot toolbar styled as Positron action bar: 28px high, 24px transparent icon buttons, 4px radius. -->
<div class="plot-toolbar" role="toolbar" aria-label="Plot tools">
  <!-- Pan tool: codicon-move -->
  <button class="tool" class:active={atlas.tool === 'pan'} aria-pressed={atlas.tool === 'pan'} aria-label="Pan and zoom"
    title="Pan and zoom: drag to pan, scroll to zoom, hover for details. Hold Shift (add) or Alt (remove) and drag to select."
    onclick={() => (atlas.tool = 'pan')}>
    <span class="codicon codicon-move" aria-hidden="true"></span>
  </button>

  <!-- Lasso tool: custom lasso SVG (16 px, currentColor, codicon style) -->
  <button class="tool" class:active={atlas.tool === 'lasso'} aria-pressed={atlas.tool === 'lasso'} aria-label="Lasso select"
    title="Lasso select: drag around points to select them. Shift adds to the selection, Alt removes, Escape clears."
    disabled={!atlas.prepared} onclick={() => (atlas.tool = atlas.tool === 'lasso' ? 'pan' : 'lasso')}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
      <ellipse cx="8" cy="6.1" rx="5.8" ry="3.5" stroke-dasharray="2 1.5"/>
      <path d="M4.2 9.1c-.6.9-.5 2.1.4 2.6.9.5 1.4 1.4 1 2.4"/>
    </svg>
  </button>

  <span class="sep" aria-hidden="true"></span>

  <!-- Fit to view: codicon-screen-normal -->
  <button class="tool" title="Fit to view: reset zoom so all points are visible" aria-label="Fit to view" disabled={!atlas.prepared} onclick={() => atlas.fitView()}>
    <span class="codicon codicon-screen-normal" aria-hidden="true"></span>
  </button>

  <span class="sep" aria-hidden="true"></span>

  <!-- Fullscreen (F1) -->
  <button class="tool" class:active={fullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
    title={fullscreen ? 'Exit full screen' : 'Full screen: maximize the Atlas panel'}
    onclick={toggleFullscreen}>
    <span class="codicon {fullscreen ? 'codicon-screen-normal' : 'codicon-screen-full'}" aria-hidden="true"></span>
  </button>
</div>
