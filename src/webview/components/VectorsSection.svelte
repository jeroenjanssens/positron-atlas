<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  let { atlas }: { atlas: Atlas } = $props();
</script>

<div class="vectors-section">
  <div class="section-header">Vectors</div>
  <label>
    <input
      type="checkbox"
      checked={atlas.showVectors}
      onchange={(e) => { atlas.saveLayoutForComparison(); atlas.setShowVectors(e.currentTarget.checked); }}
    />
    Show displacement vectors
  </label>
</div>

<style>
  .vectors-section { padding: 8px; }
  .section-header { font-weight: 600; margin-bottom: 4px; }
  label { display: flex; align-items: center; gap: 6px; }
</style>
