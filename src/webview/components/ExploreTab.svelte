<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import { SEQUENTIAL } from '../color/colormaps';

  let { atlas }: { atlas: Atlas } = $props();

  function onColorChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setColorColumn(v === '' ? null : Number(v));
  }
</script>

<Section {atlas} id="color" title="Color">
    <label class="select">
      <span>Color by</span>
      <select value={atlas.colorColumn === null ? '' : String(atlas.colorColumn)} onchange={onColorChange}>
        <option value="">None</option>
        {#each atlas.describe?.columns ?? [] as c (c.index)}
          {#if c.kind !== 'other'}<option value={String(c.index)}>{c.name}</option>{/if}
        {/each}
      </select>
    </label>
    {#if atlas.colorColumn !== null && atlas.describe?.columns[atlas.colorColumn]?.kind === 'numeric'}
      <label class="check"><input type="checkbox" bind:checked={atlas.forceCategorical} onchange={() => atlas.requestColors()} /> Treat as categories</label>
    {/if}
    {#if atlas.colorMeta?.kind === 'numeric'}
      <label class="select">
        <span>Colormap</span>
        <select value={atlas.view.colormap} onchange={(e) => atlas.setView({ colormap: (e.target as HTMLSelectElement).value })}>
          {#each Object.keys(SEQUENTIAL) as name}<option value={name}>{name}</option>{/each}
        </select>
      </label>
      {#if atlas.colorRange}
        {@const m = atlas.colorMeta}
        <label class="select">
          <span>Range</span>
          <select onchange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              atlas.colorRange = v === 'full' ? [m.min ?? 0, m.max ?? 1] : [m.q02 ?? 0, m.q98 ?? 1];
              atlas.recolor();
            }}>
            <option value="robust">2nd–98th percentile</option>
            <option value="full">Min–max</option>
          </select>
        </label>
      {/if}
    {/if}
</Section>

<Section {atlas} id="display" title="Display">
    <Slider label="Point size" bind:value={atlas.view.pointSize} min={0.5} max={20} step={0.5} tag={undefined}
      onchange={(v) => atlas.setView({ pointSize: v })} />
    <Slider label="Opacity" bind:value={atlas.view.opacity} min={0.05} max={1} step={0.05}
      onchange={(v) => atlas.setView({ opacity: v })} />
    <label class="select">
      <span>Mode</span>
      <select value={atlas.view.mode} onchange={(e) => atlas.setView({ mode: (e.target as HTMLSelectElement).value as 'points' | 'density' })}>
        <option value="points">Points</option>
        <option value="density">Density (additive)</option>
      </select>
    </label>
    <label class="select">
      <span>Background</span>
      <span class="inline">
        <input type="color" class="color" value={atlas.plotBackground()} aria-label="Plot background color"
          oninput={(e) => atlas.setView({ background: (e.target as HTMLInputElement).value })} />
        <button class="link" disabled={!atlas.view.background} title="Follow the color theme" onclick={() => atlas.setView({ background: '' })}>Theme</button>
      </span>
    </label>
    <label class="check" title={atlas.imageColumns ? `Pixel columns ${atlas.imageColumns.first} … ${atlas.imageColumns.last}` : 'No pixel columns found (numeric columns named like px0, px1, …)'}>
      <input type="checkbox" checked={atlas.view.images} disabled={!atlas.imageColumns}
        onchange={(e) => atlas.setView({ images: (e.target as HTMLInputElement).checked })} />
      Points are images
    </label>
    {#if atlas.view.images && atlas.imageColumns && atlas.imageShape}
      <label class="select">
        <span>Image width</span>
        <span class="inline">
          <input class="num" type="number" min="1" max={atlas.imageColumns.indices.length} value={atlas.imageShape[0]}
            onchange={(e) => atlas.setView({ imageWidth: Math.max(1, Number((e.target as HTMLInputElement).value) || 0) })} />
          <span class="muted-text">× {atlas.imageShape[1]}</span>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={atlas.view.imageInvert}
          onchange={(e) => atlas.setView({ imageInvert: (e.target as HTMLInputElement).checked })} />
        Invert colors
      </label>
      <div class="hint muted">{atlas.imageColumns.indices.length.toLocaleString()} pixel columns ({atlas.imageColumns.first} … {atlas.imageColumns.last}). Hover a point to see its image.</div>
    {/if}
</Section>
