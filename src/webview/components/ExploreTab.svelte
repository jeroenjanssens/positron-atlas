<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
  import { SEQUENTIAL } from '../color/colormaps';
  import { formatCount, formatPercent, formatStat } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  function onColorChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setColorColumn(v === '' ? null : Number(v));
  }
</script>

<Section {atlas} id="color" title="Color">
    <div class="select">
      <span>Color by <Info id="explore.colorBy" /></span>
      <Select value={atlas.colorColumn === null ? '' : String(atlas.colorColumn)} ariaLabel="Color by" onchange={onColorChange}>
        <option value="">None</option>
        {#each atlas.describe?.columns ?? [] as c (c.index)}
          {#if c.kind !== 'other'}<option value={String(c.index)}>{c.name}</option>{/if}
        {/each}
      </Select>
    </div>
    {#if atlas.colorColumn !== null && atlas.describe?.columns[atlas.colorColumn]?.kind === 'numeric'}
      <Checkbox bind:checked={atlas.forceCategorical} onchange={() => atlas.requestColors()}>
        Treat as categories <Info id="explore.treatAsCategories" />
      </Checkbox>
    {/if}
    {#if atlas.colorMeta?.kind === 'categorical'}
      <div class="select">
        <span>Palette <Info id="explore.palette" /></span>
        <Select value={atlas.view.palette} ariaLabel="Palette" onchange={(e) => atlas.setView({ palette: (e.target as HTMLSelectElement).value as 'map' | 'tableau' })}>
          <option value="map">Follows the map</option>
          <option value="tableau">Tableau 20</option>
        </Select>
      </div>
      {#if atlas.view.palette === 'map' && !atlas.mapColors}
        <div class="hint muted">Colors follow the map once the layout settles.</div>
      {/if}
    {/if}
    {#if atlas.colorMeta?.kind === 'numeric'}
      <div class="select">
        <span>Colormap <Info id="explore.colormap" /></span>
        <Select value={atlas.view.colormap} ariaLabel="Colormap" onchange={(e) => atlas.setView({ colormap: (e.target as HTMLSelectElement).value })}>
          {#each Object.keys(SEQUENTIAL) as name}<option value={name}>{name}</option>{/each}
        </Select>
      </div>
      {#if atlas.colorRange}
        {@const m = atlas.colorMeta}
        <div class="select">
          <span>Range <Info id="explore.colorRange" /></span>
          <Select ariaLabel="Color range" onchange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              atlas.colorRange = v === 'full' ? [m.min ?? 0, m.max ?? 1] : [m.q02 ?? 0, m.q98 ?? 1];
              atlas.recolor();
            }}>
            <option value="robust">2nd–98th percentile</option>
            <option value="full">Min–max</option>
          </Select>
        </div>
      {/if}
    {/if}
</Section>

<Section {atlas} id="display" title="Display">
    <Slider label="Point size" bind:value={atlas.view.pointSize} min={0.5} max={20} step={0.5} tag={undefined}
      onchange={(v) => atlas.setView({ pointSize: v })} infoId="explore.pointSize" />
    <Slider label="Opacity" bind:value={atlas.view.opacity} min={0.05} max={1} step={0.05}
      onchange={(v) => atlas.setView({ opacity: v })} infoId="explore.opacity" />
    <div class="select">
      <span>Mode <Info id="explore.mode" /></span>
      <Select value={atlas.view.mode} ariaLabel="Mode" onchange={(e) => atlas.setView({ mode: (e.target as HTMLSelectElement).value as 'points' | 'density' })}>
        <option value="points">Points</option>
        <option value="density">Density (additive)</option>
      </Select>
    </div>
    <label class="select">
      <span>Background <Info id="explore.background" /></span>
      <span class="inline">
        <input type="color" class="color" value={atlas.plotBackground()} aria-label="Plot background color"
          oninput={(e) => atlas.setView({ background: (e.target as HTMLInputElement).value })} />
        <button class="link" disabled={!atlas.view.background} title="Follow the color theme" onclick={() => atlas.setView({ background: '' })}>Theme</button>
      </span>
    </label>
    <Checkbox
      checked={atlas.view.images}
      disabled={!atlas.imageColumns}
      onchange={(v) => atlas.setView({ images: v })}>
      Points are images <Info id="explore.images" />
    </Checkbox>
    {#if !atlas.imageColumns}
      <div class="hint muted">No pixel columns found (numeric columns named like px0, px1, …)</div>
    {/if}
    {#if atlas.view.images && atlas.imageColumns && atlas.imageShape}
      <label class="select">
        <span>Image width <Info id="explore.imageWidth" /></span>
        <span class="inline">
          <input class="num" type="number" min="1" max={atlas.imageColumns.indices.length} value={atlas.imageShape[0]}
            onchange={(e) => atlas.setView({ imageWidth: Math.max(1, Number((e.target as HTMLInputElement).value) || 0) })} />
          <span class="muted-text">× {atlas.imageShape[1]}</span>
        </span>
      </label>
      <Checkbox
        checked={atlas.view.imageInvert}
        onchange={(v) => atlas.setView({ imageInvert: v })}>
        Invert colors <Info id="explore.imageInvert" />
      </Checkbox>
      <div class="hint muted">{atlas.imageColumns.indices.length.toLocaleString()} pixel columns ({atlas.imageColumns.first} … {atlas.imageColumns.last}). Hover a point to see its image.</div>
    {/if}
</Section>

<Section {atlas} id="selection" title="Selection">
  {#if !atlas.selection}
    <div class="hint muted">
      Select points with the lasso tool on the plot toolbar, or hold Shift and drag. Shift adds to the selection, Alt removes from it,
      Escape clears it.
    </div>
  {:else}
    <div>
      <span class="sel-count">{formatCount(atlas.selectedCount)} rows selected</span>
      <span class="muted-text">({formatPercent(atlas.selectedCount / Math.max(1, atlas.nKept))})</span>
    </div>
    {#if atlas.selectionOnAnchors}
      <div class="hint muted">Selected before all rows were placed: only the anchors are included.</div>
    {/if}
    <div class="buttons">
      <button onclick={() => atlas.clearSelection()} title="Clear the selection (Escape)">Clear</button>
      <button onclick={() => atlas.invertSelection()} title="Select the other rows instead">Invert</button>
    </div>
    <div class="buttons">
      <div class="btn-row">
        <button class="primary" disabled={atlas.comparing} onclick={() => atlas.compareSelection()}
          title="How the selected rows differ from all rows: column means and over-represented values">
          {atlas.comparing ? 'Comparing…' : 'Compare with all rows'}
        </button>
        <Info id="explore.compareSelection" />
      </div>
    </div>
    <div class="hint muted">To make a DataFrame of these rows, see Export → To the DataFrame.</div>
    {#if atlas.comparison}
      {@const c = atlas.comparison}
      <div class="compare" aria-label="Comparison of the selection with all rows">
        {#if c.categorical.length}
          <h3>Over-represented values</h3>
          {#each c.categorical as r (r.column + '\u0000' + r.value)}
            <div class="row" title="{r.column} = {r.value === '' ? '(missing)' : r.value}: {formatPercent(r.shareSelected)} of the selection, {formatPercent(r.shareAll)} of all rows">
              <span class="name">{r.column} = {r.value === '' ? '(missing)' : r.value}</span>
              <span class="val">{formatPercent(r.shareSelected)} vs {formatPercent(r.shareAll)}</span>
              <div class="bar"><span style="left:0; width:{Math.round(r.shareSelected * 100)}%"></span></div>
            </div>
          {/each}
        {/if}
        {#if c.numeric.length}
          <h3>Largest differences in means</h3>
          {#each c.numeric as r (r.column)}
            <div class="row" title="{r.column}: mean {formatStat(r.meanSelected, r.isDatetime)} in the selection, {formatStat(r.meanAll, r.isDatetime)} overall ({r.effect >= 0 ? '+' : ''}{r.effect.toFixed(2)} standard deviations)">
              <span class="name">{r.effect >= 0 ? '↑' : '↓'} {r.column}</span>
              <span class="val">{formatStat(r.meanSelected, r.isDatetime)} vs {formatStat(r.meanAll, r.isDatetime)}</span>
              <div class="bar"><span class:neg={r.effect < 0} style="left:0; width:{Math.round(Math.min(1, Math.abs(r.effect) / 3) * 100)}%"></span></div>
            </div>
          {/each}
        {/if}
        {#if !c.categorical.length && !c.numeric.length}
          <div class="hint muted">No column differs noticeably.</div>
        {/if}
        <div class="hint muted">
          {`Means of the selection vs. all rows; bars: difference in standard deviations (full at 3).${c.sampled ? ' Based on a random sample of up to 50,000 rows.' : ''}`}
        </div>
      </div>
    {/if}
  {/if}
</Section>
