<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();
</script>

<div class="tracks-section">
  <div class="section-header">Tracks</div>
  {#if atlas.trackData !== null}
    <div class="info">
      {atlas.trackData.nTracks} tracks · {atlas.trackData.nPoints} points
    </div>
  {:else}
    <div class="hint">Select ID and time columns to show tracks.</div>
  {/if}
</div>

<style>
  .tracks-section { padding: 8px; }
  .section-header { font-weight: 600; margin-bottom: 4px; }
  .info { font-size: 0.85em; }
  .hint { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; }
</style>
