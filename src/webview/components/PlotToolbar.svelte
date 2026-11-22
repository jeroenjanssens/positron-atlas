<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();

  // Keep atlas.fullscreen in sync with the browser Fullscreen API events.
  function onFullscreenChange() {
    if (!atlas.isPositron) {
      atlas.fullscreen = !!document.fullscreenElement;
    }
  }
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- Plot toolbar styled as Positron action bar: 28px high, 24px transparent icon buttons, 4px radius. -->
<div class="plot-toolbar" role="toolbar" aria-label="Plot tools">
  <!-- Pan tool: codicon-move -->
  <button class="tool" class:active={atlas.tool === 'pan'} aria-pressed={atlas.tool === 'pan'} aria-label="Pan and zoom"
    title={atlas.dims === 3 ? 'Rotate: drag to rotate, Shift-drag to pan, scroll to zoom' : 'Pan and zoom: drag to pan, scroll to zoom, hover for details. Hold Shift (add) or Alt (remove) and drag to select.'}
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

  <!-- T3: 3D camera controls (shown only in 3D mode) -->
  {#if atlas.dims === 3}
    <span class="sep" aria-hidden="true"></span>

    <!-- Auto-rotate toggle -->
    <button class="tool" class:active={atlas.autoRotate} aria-pressed={atlas.autoRotate} aria-label="Auto-rotate"
      title="Auto-rotate: continuously spin the 3D view" disabled={!atlas.prepared}
      onclick={() => atlas.toggleAutoRotate()}>
      <span class="codicon codicon-sync" aria-hidden="true"></span>
    </button>

    <span class="sep" aria-hidden="true"></span>

    <!-- Camera presets -->
    <button class="tool" aria-label="Top view" title="Top view: look straight down" disabled={!atlas.prepared}
      onclick={() => atlas.setCameraPreset('top')}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1"/>
        <line x1="8" y1="1" x2="8" y2="3"/>
        <line x1="8" y1="13" x2="8" y2="15"/>
      </svg>
    </button>
    <button class="tool" aria-label="Front view" title="Front view: look along the Y axis" disabled={!atlas.prepared}
      onclick={() => atlas.setCameraPreset('front')}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1"/>
        <line x1="1" y1="8" x2="3" y2="8"/>
        <line x1="13" y1="8" x2="15" y2="8"/>
      </svg>
    </button>
    <button class="tool" aria-label="Side view" title="Side view: look along the X axis" disabled={!atlas.prepared}
      onclick={() => atlas.setCameraPreset('side')}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1"/>
        <line x1="13" y1="8" x2="15" y2="8"/>
        <line x1="1" y1="8" x2="3" y2="8"/>
        <line x1="10" y1="5" x2="13" y2="8"/>
        <line x1="10" y1="11" x2="13" y2="8"/>
      </svg>
    </button>
  {/if}

  <!-- Compass: 2D rotation indicator + reset (item 14, hidden in 3D) -->
  {#if atlas.dims !== 3 && atlas.rotation2D !== 0}
    <button class="tool compass" aria-label="Reset rotation" disabled={!atlas.prepared}
      title="Rotation: {atlas.rotation2D.toFixed(0)}°. Click to reset to north-up."
      onclick={() => atlas.resetRotation2D()}>
      <!-- Compass needle SVG, rotated by rotation2D degrees -->
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
        style="transform: rotate({atlas.rotation2D}deg); transform-origin: 50% 50%;">
        <!-- North arrow (red tip pointing up) -->
        <polygon points="8,2 10,10 8,8.5 6,10" fill="var(--vscode-charts-red, #f14c4c)" />
        <!-- South arrow (grey) -->
        <polygon points="8,14 10,6 8,7.5 6,6" fill="currentColor" opacity="0.5" />
        <!-- Center dot -->
        <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      </svg>
    </button>
  {/if}

  <!-- Annotate tool (A4): codicon-pin; hidden in 3D (T5) -->
  {#if atlas.dims !== 3}
    <button class="tool" class:active={atlas.tool === 'annotate'} aria-pressed={atlas.tool === 'annotate'} aria-label="Annotate"
      title="Annotate: click a point to add a callout annotation. Drag the callout to move it; double-click to edit text."
      disabled={!atlas.prepared} onclick={() => (atlas.tool = atlas.tool === 'annotate' ? 'pan' : 'annotate')}>
      <span class="codicon codicon-pin" aria-hidden="true"></span>
    </button>
  {/if}

  <span class="sep" aria-hidden="true"></span>

  <!-- Undo (A3) -->
  <button class="tool" aria-label={atlas.undoLabel ? `Undo: ${atlas.undoLabel}` : 'Undo'}
    title={atlas.undoLabel ? `Undo: ${atlas.undoLabel}` : 'Nothing to undo'}
    disabled={!atlas.undoLabel}
    onclick={() => atlas.undo()}>
    <span class="codicon codicon-discard" aria-hidden="true"></span>
  </button>

  <!-- Redo (A3) -->
  <button class="tool" aria-label={atlas.redoLabel ? `Redo: ${atlas.redoLabel}` : 'Redo'}
    title={atlas.redoLabel ? `Redo: ${atlas.redoLabel}` : 'Nothing to redo'}
    disabled={!atlas.redoLabel}
    onclick={() => atlas.redo()}>
    <span class="codicon codicon-redo" aria-hidden="true"></span>
  </button>

  <!-- Fullscreen (F1) -->
  <button class="tool" class:active={atlas.fullscreen} aria-pressed={atlas.fullscreen} aria-label={atlas.fullscreen ? 'Exit full screen' : 'Full screen'}
    title={atlas.fullscreen ? 'Exit full screen' : 'Full screen: maximize the Atlas panel'}
    onclick={() => atlas.toggleFullscreen()}>
    <span class="codicon {atlas.fullscreen ? 'codicon-screen-normal' : 'codicon-screen-full'}" aria-hidden="true"></span>
  </button>
</div>
