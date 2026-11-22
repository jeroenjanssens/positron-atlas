<script lang="ts">
  import { MAX_LABELS, type Atlas } from '../atlas.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Info from './controls/Info.svelte';
  import Select from './controls/Select.svelte';
  import NumberInput from './controls/NumberInput.svelte';
  import FontPicker from './controls/FontPicker.svelte';
  import { formatCount } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();

  const labelColumns = $derived(
    (atlas.describe?.columns ?? []).filter(
      (c) =>
        c.kind === 'categorical' ||
        c.kind === 'bool' ||
        (c.kind === 'numeric' && /int/i.test(c.dtype) && (c.n_unique_est ?? Infinity) <= MAX_LABELS),
    ),
  );
  const meta = $derived(atlas.labelMeta);
  // "Color labels like the points" is only available when labels and colors use the same column.
  const sameAsColor = $derived(atlas.labels.column !== null && atlas.labels.column === atlas.colorColumn && atlas.colorMeta?.kind === 'categorical');

  const source = $derived(atlas.labels.clusters ? 'clusters' : atlas.labels.column === null ? '' : String(atlas.labels.column));
  const detailNames = ['Coarsest', 'Coarse', 'Medium', 'Fine', 'Finest'];
  let tag = $state('');
  let tagColumn = $state('atlas_tag');
  // A9: highlight groups text input
  let highlightInput = $state('');

  function onLabelChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setLabelSource(v === '' ? null : v === 'clusters' ? 'clusters' : Number(v));
  }
  function onNameByChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setLabelOptions({ nameBy: v === 'number' || v === 'features' ? v : Number(v) });
  }
  function onFineColumnChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    atlas.setLabelOptions({ fineColumn: v === '' ? null : Number(v) });
  }

  // A3: drag offset keys that have been moved
  const movedLabels = $derived(Object.keys(atlas.labels.dragOffsets ?? {}));

  // A9: add/remove highlight groups
  function addHighlight() {
    const name = highlightInput.trim();
    if (!name) return;
    const existing = atlas.labels.highlightGroups ?? [];
    if (!existing.includes(name)) {
      atlas.setLabelOptions({ highlightGroups: [...existing, name] });
    }
    highlightInput = '';
  }
  function removeHighlight(name: string) {
    atlas.setLabelOptions({ highlightGroups: (atlas.labels.highlightGroups ?? []).filter((g) => g !== name) });
  }
</script>

<Section {atlas} id="labels" title="Labels">
  <div class="select">
    <span>Label by <Info id="labels.labelBy" /></span>
    <Select value={source} ariaLabel="Label by" onchange={onLabelChange}>
      <option value="">None</option>
      <option value="clusters">Automatic clusters</option>
      {#if labelColumns.length}
        <optgroup label="Columns">
          {#each labelColumns as c (c.index)}<option value={String(c.index)}>{c.name}</option>{/each}
        </optgroup>
      {/if}
    </Select>
  </div>
  {#if atlas.labels.clusters}
    <Slider label="Detail" value={atlas.labels.detail} min={1} max={5} format={(v) => detailNames[v - 1] ?? ''}
      hint="How finely the layout is split into clusters: 1 gives fewer, larger clusters; 5 more, smaller ones"
      onchange={(v) => atlas.setLabelOptions({ detail: v })} infoId="labels.detail" />
    <Checkbox
      checked={atlas.labels.multiLevel ?? false}
      onchange={(v) => atlas.setLabelOptions({ multiLevel: v })}>
      Show two levels of detail <Info id="labels.multiLevel" />
    </Checkbox>
    <div class="select">
      <span>Name by <Info id="labels.nameBy" /></span>
      <Select value={String(atlas.labels.nameBy)} ariaLabel="Name clusters by" onchange={onNameByChange}>
        <option value="number">Number</option>
        <option value="features">Distinguishing columns</option>
        {#if labelColumns.length}
          <optgroup label="Most common value of">
            {#each labelColumns as c (c.index)}<option value={String(c.index)}>{c.name}</option>{/each}
          </optgroup>
        {/if}
      </Select>
    </div>
    <Checkbox
      checked={atlas.labels.outlines}
      onchange={(v) => atlas.setLabelOptions({ outlines: v })}>
      Show outlines <Info id="labels.outlines" />
    </Checkbox>
    <div class="btn-row">
      <button disabled={!atlas.clusterCount || atlas.clustering} onclick={() => atlas.clustersToFrame('atlas_cluster')}
        title="Write each row's cluster name into the column atlas_cluster of the DataFrame (rows in no cluster: missing)">Add clusters to DataFrame</button>
      <Info id="labels.addToFrame" />
    </div>
    <div class="hint muted">
      {#if atlas.clustering}
        Finding clusters…
      {:else if atlas.clusterCount}
        {formatCount(atlas.clusterCount)} clusters, found in the density of the layout when it settles.
        {#if atlas.labels.nameBy === 'features'}Names show the columns whose means differ most (↑ higher, ↓ lower).{/if}
      {:else if atlas.phase === 'embedding'}
        Clusters are found when the layout settles.
      {:else}
        No clusters yet.
      {/if}
    </div>
  {:else if atlas.labels.column !== null}
    <!-- A8: second (finer) column for column labels -->
    <div class="select">
      <span>Fine labels by <Info id="labels.fineColumn" /></span>
      <Select value={atlas.labels.fineColumn !== null && atlas.labels.fineColumn !== undefined ? String(atlas.labels.fineColumn) : ''} ariaLabel="Fine label column" onchange={onFineColumnChange}>
        <option value="">None</option>
        {#if labelColumns.length}
          {#each labelColumns as c (c.index)}
            {#if c.index !== atlas.labels.column}
              <option value={String(c.index)}>{c.name}</option>
            {/if}
          {/each}
        {/if}
      </Select>
    </div>
  {/if}
  {#if labelColumns.length === 0 && !atlas.labels.clusters}
    <div class="hint muted">No column to label by: labels need a text, categorical, boolean or integer column.</div>
  {/if}
  {#if atlas.labels.column !== null || atlas.labels.clusters}
    <Slider label="Smallest label" bind:value={atlas.labels.minSize} min={6} max={40}
      hint="Font size (pixels) of labels for the smallest groups"
      onchange={(v) => atlas.setLabelOptions({ minSize: v, maxSize: Math.max(v, atlas.labels.maxSize) })}
      infoId="labels.minSize" />
    <Slider label="Largest label" bind:value={atlas.labels.maxSize} min={6} max={64}
      hint="Font size (pixels) of the label of the largest group"
      onchange={(v) => atlas.setLabelOptions({ maxSize: v, minSize: Math.min(v, atlas.labels.minSize) })}
      infoId="labels.maxSize" />
    {#if sameAsColor}
      <Checkbox
        checked={atlas.labels.colorText}
        onchange={(v) => atlas.setLabelOptions({ colorText: v })}>
        Color labels like the points <Info id="labels.colorText" />
      </Checkbox>
    {:else if atlas.labels.column !== null || atlas.labels.clusters}
      <div class="hint muted" title="Color labels like the points is only available when the label column and color column are the same">
        Color labels like the points (available when labeling and coloring by the same column)
      </div>
    {/if}
    {#if atlas.labels.clusters}
      {#if atlas.labelCount}<div class="hint muted">Bigger clusters get bigger labels. Labels that would overlap are hidden; zoom in to see more.</div>{/if}
    {:else if meta}
      <div class="hint muted">
        {formatCount(atlas.labelCount)} labels{#if meta.nUnique > meta.categories.length}, for the {formatCount(meta.categories.length)} most frequent of {formatCount(meta.nUnique)} values{/if}.
        Bigger groups get bigger labels. Labels that would overlap are hidden; zoom in to see more.
      </div>
    {:else}
      <div class="hint muted">Loading labels…</div>
    {/if}
  {/if}
</Section>

<!-- A2: Label Typography -->
<Section {atlas} id="labelTypography" title="Label typography">
  <!-- Font family picker (D11: bundled + Google Fonts catalogue + installed) -->
  <div class="select">
    <span>Font <Info id="labels.fontFamily" /></span>
    <FontPicker value={atlas.labels.fontFamily ?? ''} ariaLabel="Label font" onchange={(f) => atlas.setLabelOptions({ fontFamily: f })} />
  </div>
  <!-- Base weight (shown as a weight slider) -->
  <Slider label="Font weight" value={atlas.labels.fontWeight ?? 600} min={100} max={900} step={100}
    hint="Base font weight for all labels (100 = thin, 400 = regular, 700 = bold, 900 = black)"
    onchange={(v) => atlas.setLabelOptions({ fontWeight: v })} infoId="labels.fontWeight" />
  <!-- Dynamic weight range -->
  <Slider label="Min weight (small groups)" value={atlas.labels.minFontWeight ?? 400} min={100} max={900} step={100}
    hint="Font weight for the label of the smallest group; smaller groups get lighter labels (like DataMapPlot min_font_weight)"
    onchange={(v) => atlas.setLabelOptions({ minFontWeight: v, maxFontWeight: Math.max(v, atlas.labels.maxFontWeight ?? 700) })}
    infoId="labels.minFontWeight" />
  <Slider label="Max weight (large groups)" value={atlas.labels.maxFontWeight ?? 700} min={100} max={900} step={100}
    hint="Font weight for the label of the largest group; larger groups get heavier labels (like DataMapPlot max_font_weight)"
    onchange={(v) => atlas.setLabelOptions({ maxFontWeight: v, minFontWeight: Math.min(v, atlas.labels.minFontWeight ?? 400) })}
    infoId="labels.maxFontWeight" />
  <!-- Wrap and spacing -->
  <div class="select">
    <span>Wrap width (chars) <Info id="labels.wrapWidth" /></span>
    <NumberInput value={atlas.labels.wrapWidth ?? 9} min={0} max={80} step={1} ariaLabel="Wrap width"
      onchange={(e) => atlas.setLabelOptions({ wrapWidth: Number((e.target as HTMLInputElement).value) })} />
  </div>
  <Slider label="Line spacing" value={atlas.labels.lineSpacing ?? 0.95} min={0.5} max={3} step={0.05}
    format={(v) => v.toFixed(2)}
    hint="Line height multiplier for multi-line labels"
    onchange={(v) => atlas.setLabelOptions({ lineSpacing: v })} infoId="labels.lineSpacing" />
  <!-- Halo / outline -->
  <Slider label="Halo width" value={atlas.labels.haloWidth ?? 10} min={0} max={30}
    hint="Width of the outline/halo drawn behind each label for readability"
    onchange={(v) => atlas.setLabelOptions({ haloWidth: v })} infoId="labels.haloWidth" />
  <div class="select">
    <span>Halo color <Info id="labels.haloColor" /></span>
    <input class="ctrl-color" type="color" value={atlas.labels.haloColor || '#000000'}
      title="Halo color. Leave the default to match the plot background."
      onchange={(e) => atlas.setLabelOptions({ haloColor: (e.target as HTMLInputElement).value })} />
    <button class="small" onclick={() => atlas.setLabelOptions({ haloColor: '' })} title="Reset to auto (match plot background)">Auto</button>
  </div>
  <!-- Letter case -->
  <div class="select">
    <span>Letter case <Info id="labels.textCase" /></span>
    <Select value={atlas.labels.textCase ?? 'asis'} ariaLabel="Letter case" onchange={(e) => atlas.setLabelOptions({ textCase: (e.target as HTMLSelectElement).value as 'asis' | 'upper' })}>
      <option value="asis">As is</option>
      <option value="upper">UPPERCASE</option>
    </Select>
  </div>
</Section>

<!-- A9: Highlighted labels -->
<Section {atlas} id="labelHighlights" title="Highlighted labels">
  <div class="hint muted">Groups shown as filled badges (cluster color, white text), like DataMapPlot's highlight_labels.</div>
  <div class="select">
    <span>Add group <Info id="labels.highlightGroups" /></span>
    <input class="ctrl-text" type="text" placeholder="Group name" bind:value={highlightInput} aria-label="Group name to highlight"
      onkeydown={(e) => e.key === 'Enter' && addHighlight()} />
    <button class="small" onclick={addHighlight} disabled={!highlightInput.trim()}>Add</button>
  </div>
  {#if (atlas.labels.highlightGroups ?? []).length}
    <div class="tag-list">
      {#each atlas.labels.highlightGroups ?? [] as g}
        <span class="tag">
          {g}
          <button class="tag-remove" onclick={() => removeHighlight(g)} title="Remove">&times;</button>
        </span>
      {/each}
    </div>
  {:else}
    <div class="hint muted">No highlighted groups yet.</div>
  {/if}
</Section>

<!-- A3: Label positions -->
<Section {atlas} id="labelPositions" title="Label positions">
  <div class="hint muted">Drag a label on the map (pan mode) to move it. Right-click to reset a single label's position.</div>
  {#if movedLabels.length}
    <div class="hint muted">{movedLabels.length} label{movedLabels.length === 1 ? '' : 's'} moved: {movedLabels.join(', ')}</div>
    <div class="btn-row">
      <button onclick={() => atlas.resetAllDragOffsets()}>Reset all label positions</button>
      <Info id="labels.resetPositions" />
    </div>
  {:else}
    <div class="hint muted">No labels have been moved.</div>
  {/if}
</Section>

<Section {atlas} id="tags" title="Tags">
  <label class="select">
    <span>Tag <Info id="tags.tag" /></span>
    <input class="text" type="text" placeholder="e.g. outliers" bind:value={tag} aria-label="Tag" />
  </label>
  <label class="select">
    <span>Column <Info id="tags.column" /></span>
    <input class="text" type="text" bind:value={tagColumn} aria-label="Tag column" />
  </label>
  <div class="btn-row">
    <button class="primary" disabled={!atlas.selection || !tag.trim() || !tagColumn.trim()} onclick={() => atlas.tagSelection(tag, tagColumn)}>
      {atlas.selection ? `Tag ${formatCount(atlas.selectedCount)} selected rows` : 'Tag selected rows'}
    </button>
    <Info id="tags.apply" />
  </div>
  <div class="hint muted">
    {#if !atlas.selection}Select points first, with the lasso tool or Shift-drag.{:else}Writes the tag into {tagColumn.trim() || 'the column'} of {atlas.variable}; you can then color or label by it.{/if}
  </div>
</Section>

<style>
  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 1px 6px 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-badge-background, #3a3d41);
    background: var(--vscode-badge-background, #3a3d41);
    color: var(--vscode-badge-foreground, #ffffff);
    font-size: 11px;
  }
  .tag-remove {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    opacity: 0.7;
    padding: 0 2px;
    font-size: 13px;
    line-height: 1;
  }
  .tag-remove:hover {
    opacity: 1;
  }
  .ctrl-color {
    width: 32px;
    height: 22px;
    padding: 1px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 3px;
    cursor: pointer;
    background: none;
  }
  .ctrl-text {
    flex: 1;
    padding: 2px 6px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 3px;
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #cccccc);
    font-size: 12px;
  }
  button.small {
    padding: 2px 8px;
    font-size: 12px;
  }
</style>
