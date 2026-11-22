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

  // ---- Title overlay (A1) ----
  const title = $derived(atlas.titleOverlay);

  function setTitle(partial: Partial<typeof title>) {
    atlas.titleOverlay = { ...atlas.titleOverlay, ...partial };
  }

  function onLogoFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setTitle({ logoData: reader.result });
      }
    };
    reader.readAsDataURL(file);
  }

  // ---- Annotations list (A4) ----
  const annotationList = $derived([...atlas.annotations.values()]);

  function goToAnnotation(ann: { worldX: number; worldY: number }) {
    // Zoom to and center the annotated point.
    atlas.renderer?.fit([ann.worldX - 1, ann.worldY - 1, ann.worldX + 1, ann.worldY + 1], true, atlas.legendWidth());
  }

  let importError = $state('');

  function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        atlas.importAnnotationsJson(String(reader.result));
        importError = '';
      } catch (err) {
        importError = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    reader.readAsText(file);
  }

  function downloadAnnotations() {
    const json = atlas.exportAnnotationsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${atlas.variable || 'annotations'}_annotations.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
  // A9: available group names for the highlight picker
  const availableGroups = $derived(
    atlas.labels.clusters
      ? atlas.clusterNames
      : (atlas.labelMeta?.categories ?? [])
  );

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
  function toggleHighlight(name: string, on: boolean) {
    const existing = atlas.labels.highlightGroups ?? [];
    if (on && !existing.includes(name)) {
      atlas.setLabelOptions({ highlightGroups: [...existing, name] });
    } else if (!on) {
      atlas.setLabelOptions({ highlightGroups: existing.filter((g) => g !== name) });
    }
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
    <!-- A11: label style (over / around) -->
    <div class="select">
      <span>Label style <Info id="labels.labelStyle" /></span>
      <Select value={atlas.labels.labelStyle ?? 'over'} ariaLabel="Label style"
        onchange={(e) => atlas.setLabelOptions({ labelStyle: (e.target as HTMLSelectElement).value as 'over' | 'around' })}>
        <option value="over">Over the points</option>
        <option value="around">Around the map</option>
      </Select>
    </div>
    {#if (atlas.labels.labelStyle ?? 'over') === 'around'}
      <div class="select">
        <span>Leader style <Info id="labels.leaderStyle" /></span>
        <Select value={atlas.labels.leaderStyle ?? 'straight'} ariaLabel="Leader style"
          onchange={(e) => atlas.setLabelOptions({ leaderStyle: (e.target as HTMLSelectElement).value as 'straight' | 'curved' | 'wedge' })}>
          <option value="straight">Straight</option>
          <option value="curved">Curved</option>
          <option value="wedge">Wedge</option>
        </Select>
      </div>
      <div class="select">
        <span>Leader color <Info id="labels.leaderColor" /></span>
        <Select value={atlas.labels.leaderColor ?? 'cluster'} ariaLabel="Leader color"
          onchange={(e) => atlas.setLabelOptions({ leaderColor: (e.target as HTMLSelectElement).value as 'cluster' | 'grey' })}>
          <option value="cluster">Like the cluster</option>
          <option value="grey">Grey</option>
        </Select>
      </div>
      <Slider label="Leader width" value={atlas.labels.leaderWidth ?? 1.5} min={0.5} max={8} step={0.5}
        hint="Stroke width of the leader lines in CSS pixels"
        onchange={(v) => atlas.setLabelOptions({ leaderWidth: v })} infoId="labels.leaderWidth" />
    {/if}
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
  <div class="hint muted">Groups shown as filled badges (cluster color, white text), like DataMapPlot's highlight_labels. <Info id="labels.highlightGroups" /></div>
  {#if availableGroups.length === 0}
    <div class="hint muted">Enable labels above to pick groups to highlight.</div>
  {:else}
    <div class="highlight-group-list">
      {#each availableGroups as g, i (i)}
        <Checkbox
          checked={(atlas.labels.highlightGroups ?? []).includes(g)}
          onchange={(v) => toggleHighlight(g, v)}>
          {g}
        </Checkbox>
      {/each}
    </div>
  {/if}
  {#if (atlas.labels.highlightGroups ?? []).length}
    <div class="tag-list">
      {#each atlas.labels.highlightGroups ?? [] as g}
        <span class="tag">
          {g}
          <button class="tag-remove" onclick={() => removeHighlight(g)} title="Remove">&times;</button>
        </span>
      {/each}
    </div>
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

<!-- Title / subtitle / logo overlay (A1) -->
<Section {atlas} id="titleOverlay" title="Title">
  <label class="select">
    <span>Title <Info id="titleOverlay.title" /></span>
    <input class="text" type="text" placeholder="Map title" value={title.title}
      oninput={(e) => setTitle({ title: (e.target as HTMLInputElement).value })} aria-label="Map title" />
  </label>
  <label class="select">
    <span>Subtitle <Info id="titleOverlay.subtitle" /></span>
    <input class="text" type="text" placeholder="Subtitle (optional)" value={title.subtitle}
      oninput={(e) => setTitle({ subtitle: (e.target as HTMLInputElement).value })} aria-label="Subtitle" />
  </label>
  <div class="select">
    <span>Font <Info id="titleOverlay.fontFamily" /></span>
    <FontPicker value={title.fontFamily} ariaLabel="Title font" onchange={(f) => setTitle({ fontFamily: f })} />
  </div>
  <Slider label="Size" value={title.fontSize} min={10} max={72} format={(v) => `${v}px`}
    hint="Title font size in pixels"
    onchange={(v) => setTitle({ fontSize: v })} infoId="titleOverlay.fontSize" />
  <label class="select">
    <span>Color <Info id="titleOverlay.color" /></span>
    <input type="color" class="color" value={title.color || '#cccccc'}
      oninput={(e) => setTitle({ color: (e.target as HTMLInputElement).value })} aria-label="Title color" />
  </label>
  <label class="select">
    <span>Logo <Info id="titleOverlay.logo" /></span>
    <input type="file" accept="image/*" onchange={onLogoFile} aria-label="Choose logo image" />
  </label>
  {#if title.logoData}
    <div class="logo-preview">
      <img src={title.logoData} alt="Logo preview" style="max-height:40px;max-width:80px;object-fit:contain;" />
      <button onclick={() => setTitle({ logoData: '' })} title="Remove logo">Remove</button>
    </div>
  {/if}
  <Slider label="Logo width" value={title.logoWidth || 48} min={16} max={160} format={(v) => `${v}px`}
    hint="Logo width in pixels (0 = 48 px)"
    onchange={(v) => setTitle({ logoWidth: v })} infoId="titleOverlay.logoWidth" />
  {#if !title.title.trim() && !title.subtitle.trim() && !title.logoData}
    <div class="hint muted">Enter a title above, then it appears as an overlay on the map (top left) and is included in PNG exports.</div>
  {/if}
</Section>

<!-- Point annotations (A4) -->
<Section {atlas} id="pointAnnotations" title="Annotations">
  <div class="hint muted">
    <Info id="pointAnnotations.list" />
    Use the <span class="codicon codicon-pin" aria-label="pin" style="font-size:12px;vertical-align:-1px;"></span> Annotate tool in the toolbar to click a point and add a callout, or click <strong>Annotate</strong> on the hover card.
    Drag callouts to reposition them; double-click to edit text.
  </div>
  {#if annotationList.length}
    <div class="ann-list" role="list">
      {#each annotationList as ann (ann.id)}
        <div class="ann-item" role="listitem">
          <button class="ann-goto icon-btn" title="Go to annotation" onclick={() => goToAnnotation(ann)}>
            <span class="codicon codicon-location" aria-hidden="true"></span>
          </button>
          <span class="ann-item-text" title={ann.text}>{ann.text || `Row ${ann.row}`}</span>
          <button class="ann-del icon-btn" title="Delete" onclick={() => atlas.removeAnnotation(ann.id)}>
            <span class="codicon codicon-trash" aria-hidden="true"></span>
          </button>
        </div>
      {/each}
    </div>
    <div class="btn-row">
      <button onclick={downloadAnnotations} title="Export annotations as JSON">Export JSON</button>
      <button class="danger" onclick={() => atlas.clearAnnotations()} title="Remove all annotations">Clear all</button>
    </div>
  {:else}
    <div class="hint muted">No annotations yet.</div>
  {/if}
  <div class="btn-row">
    <label class="file-btn" title="Import annotations from a JSON file">
      Import JSON
      <input type="file" accept=".json,application/json" onchange={onImportFile} style="display:none" />
    </label>
  </div>
  {#if importError}<div class="hint error">{importError}</div>{/if}
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
  button.small {
    padding: 2px 8px;
    font-size: 12px;
  }
  .highlight-group-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 160px;
    overflow-y: auto;
  }
  .logo-preview { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .ann-list { display: flex; flex-direction: column; gap: 2px; margin: 4px 0; }
  .ann-item { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
  .ann-item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9em; }
  .ann-goto, .ann-del { background: none; border: none; cursor: pointer; color: var(--muted); padding: 0 2px; display: flex; align-items: center; }
  .ann-goto:hover, .ann-del:hover { color: var(--vscode-editor-foreground, #ccc); }
  .ann-goto .codicon, .ann-del .codicon { font-size: 13px; }
  .file-btn { display: inline-block; padding: 3px 10px; background: var(--btn-bg); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; font: inherit; color: var(--btn-fg); }
  .file-btn:hover { background: var(--btn-hover-bg, var(--btn-bg)); }
  .hint.error { color: var(--vscode-errorForeground, #f14c4c); }
  .danger { background: var(--vscode-errorForeground, #f14c4c); color: #fff; }
</style>
