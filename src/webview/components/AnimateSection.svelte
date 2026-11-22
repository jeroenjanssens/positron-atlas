<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();
</script>

<div class="animate-section">
  <div class="section-header">Animate</div>
  {#if atlas.animateValues !== null}
    <div class="controls">
      <button onclick={() => atlas.togglePlay()}>
        {atlas.animatePlaying ? 'Pause' : 'Play'}
      </button>
      <label>
        Window position
        <input
          type="range" min="0" max="1" step="0.01"
          value={atlas.animate.windowPos}
          oninput={(e) => atlas.setAnimateWindow(+e.currentTarget.value, atlas.animate.windowSize)}
        />
      </label>
      <label>
        Window size
        <input
          type="range" min="0.01" max="1" step="0.01"
          value={atlas.animate.windowSize}
          oninput={(e) => atlas.setAnimateWindow(atlas.animate.windowPos, +e.currentTarget.value)}
        />
      </label>
    </div>
  {:else}
    <div class="hint">Select a column to animate over time.</div>
  {/if}
</div>

<style>
  .animate-section { padding: 8px; }
  .section-header { font-weight: 600; margin-bottom: 4px; }
  .controls { display: flex; flex-direction: column; gap: 6px; }
  .hint { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; }
</style>
