<script lang="ts">
  /**
   * Controls cheat sheet (item 2, B1).
   *
   * Shows all mouse and keyboard controls for the active preset, in the host OS
   * key notation (macOS glyphs or words).  A preset dropdown lets the user switch
   * the preset live.  Escape closes the panel.
   *
   * Opening: `?` key (view.showControls action), toolbar button, Command Palette.
   */
  import type { Atlas } from '../atlas.svelte';
  import { BINDINGS, defaultKey, formatKey, type BindingEntry } from '../input/bindings';

  let { atlas }: { atlas: Atlas } = $props();

  // ---- Platform notation ------------------------------------------------------
  const platform = $derived(
    atlas.platform === 'darwin' ? 'mac' : atlas.platform === 'win32' ? 'win' : 'linux',
  );

  // ---- Active row highlight ---------------------------------------------------
  /** actionId that was most recently dispatched. */
  let lastAction = $state<string | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called by Atlas (or dispatcher) when an action is dispatched. */
  export function highlightAction(actionId: string): void {
    lastAction = actionId;
    if (highlightTimer !== null) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => { lastAction = null; }, 1500);
  }

  // ---- Key display (user overrides merged with defaults) ----------------------
  function displayKey(entry: BindingEntry): string {
    // Check if the user has rebound this action.
    const cmdId = `positronAtlas.nav.${entry.actionId}`;
    const override = atlas.userKeybindings?.find((kb) => kb.command === cmdId);
    if (override) {
      return formatKey(override.key, platform);
    }
    const def = defaultKey(entry, platform);
    return def ? formatKey(def, platform) : '—';
  }

  // ---- Section grouping -------------------------------------------------------
  type Section = 'navigate' | 'select' | 'annotate' | 'view' | 'misc';
  const SECTION_LABELS: Record<Section, string> = {
    navigate: 'Navigate',
    select: 'Select',
    annotate: 'Annotate',
    view: 'View (3D)',
    misc: 'Panels',
  };

  const preset = $derived(atlas.navSettings.preset);

  /** Bindings visible in the current dims context. */
  const visibleBindings = $derived(
    BINDINGS.filter((b) => {
      if (b.context === '2d' && atlas.dims === 3) return false;
      if (b.context === '3d' && atlas.dims === 2) return false;
      // Always show both so users can see the full set; dims note in tooltip
      return true;
    }),
  );

  const sections = $derived(
    (['navigate', 'select', 'annotate', 'view', 'misc'] as Section[]).map((sec) => ({
      id: sec,
      label: SECTION_LABELS[sec],
      entries: visibleBindings.filter((b) => b.section === sec),
    })).filter((s) => s.entries.length > 0),
  );

  function onPresetChange(e: Event) {
    const sel = (e.target as HTMLSelectElement).value as 'dataMap' | 'molecular' | 'cad' | 'design';
    atlas.navSettings = { ...atlas.navSettings, preset: sel };
    atlas.renderer?.setNavSettings(atlas.navSettings, atlas.dims);
    // Also persist via postMessage so host can save the setting.
    atlas.post({ type: 'log', level: 'info', message: `nav preset → ${sel}` });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      atlas.cheatSheetVisible = false;
    }
  }

  function openKeyboardShortcuts() {
    atlas.post({ type: 'openCommand', command: 'workbench.action.openGlobalKeybindings', args: ['positronAtlas'] });
  }

  function openNavSettings() {
    atlas.post({ type: 'openCommand', command: 'workbench.action.openSettings', args: ['positronAtlas.navigation'] });
  }

  const PRESET_LABELS: Record<string, string> = {
    dataMap: 'Data map (default)',
    molecular: 'Molecular viewer',
    cad: '3D / CAD',
    design: 'Design',
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="cheat-sheet"
  role="dialog"
  aria-label="Atlas controls"
  aria-modal="false"
  tabindex="-1"
  onkeydown={onKeyDown}
>
  <div class="cs-header">
    <span class="cs-title">Controls</span>
    <!-- Preset selector -->
    <label class="cs-preset-label" for="cs-preset">Preset</label>
    <select id="cs-preset" class="cs-preset-select" value={preset} onchange={onPresetChange}
      aria-label="Navigation preset">
      <option value="dataMap">{PRESET_LABELS.dataMap}</option>
      <option value="molecular">{PRESET_LABELS.molecular}</option>
      <option value="cad">{PRESET_LABELS.cad}</option>
      <option value="design">{PRESET_LABELS.design}</option>
    </select>

    <!-- Close button -->
    <button class="cs-close codicon codicon-close" aria-label="Close controls" title="Close (Escape)"
      onclick={() => (atlas.cheatSheetVisible = false)}></button>
  </div>

  <div class="cs-body">
    {#each sections as sec (sec.id)}
      <div class="cs-section">
        <div class="cs-section-title">{sec.label}</div>
        <table class="cs-table">
          <tbody>
          {#each sec.entries as entry (entry.actionId)}
            {@const isActive = lastAction === entry.actionId}
            <tr class="cs-row" class:cs-active={isActive}>
              <td class="cs-action">{entry.label}</td>
              <td class="cs-mouse">
                {#if entry.mouse?.[preset as keyof typeof entry.mouse]}
                  {entry.mouse[preset as keyof typeof entry.mouse]}
                {:else if entry.mouse?.dataMap && preset !== 'dataMap'}
                  —
                {:else}
                  {entry.mouse?.dataMap ?? ''}
                {/if}
              </td>
              <td class="cs-key"><kbd>{displayKey(entry)}</kbd></td>
            </tr>
          {/each}
          </tbody>
        </table>
      </div>
    {/each}
  </div>

  <div class="cs-footer">
    {#if !atlas.isPositron}
      <span class="cs-note">Running outside Positron — keybindings may differ.</span>
    {:else if atlas.userKeybindings === null}
      <span class="cs-note">Showing default shortcuts (keybindings.json not read).</span>
    {/if}
    <button class="cs-link" onclick={openKeyboardShortcuts}>Change keyboard shortcuts…</button>
    <button class="cs-link" onclick={openNavSettings}>Navigation settings…</button>
  </div>
</div>

<style>
  .cheat-sheet {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: 50%;
    background: var(--vscode-editor-background, #1e1e1e);
    border-top: 1px solid var(--vscode-panel-border, #444);
    display: flex;
    flex-direction: column;
    z-index: 100;
    font-size: 12px;
    color: var(--vscode-editor-foreground, #ccc);
    overflow: hidden;
  }

  .cs-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 4px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
  }

  .cs-title {
    font-weight: 600;
    font-size: 12px;
    margin-right: 4px;
    white-space: nowrap;
  }

  .cs-preset-label {
    color: var(--vscode-descriptionForeground, #888);
    white-space: nowrap;
  }

  .cs-preset-select {
    background: var(--vscode-dropdown-background, #2a2a2a);
    color: var(--vscode-dropdown-foreground, #ccc);
    border: 1px solid var(--vscode-dropdown-border, #444);
    border-radius: 3px;
    padding: 1px 20px 1px 6px;
    font-size: 12px;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }

  .cs-close {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--vscode-icon-foreground, #ccc);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
  }
  .cs-close:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
  }

  .cs-body {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0;
    overflow-y: auto;
    padding: 6px 10px 4px;
    flex: 1;
  }

  .cs-section {
    min-width: 200px;
    flex: 1;
    padding-right: 16px;
  }

  .cs-section-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground, #888);
    padding-bottom: 3px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    margin-bottom: 4px;
  }

  .cs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .cs-row {
    transition: background 0.1s;
  }
  .cs-row.cs-active {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    border-radius: 3px;
  }
  .cs-row td {
    padding: 2px 4px;
    vertical-align: middle;
  }

  .cs-action {
    color: var(--vscode-editor-foreground, #ccc);
    white-space: nowrap;
  }

  .cs-mouse {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    white-space: nowrap;
  }

  .cs-key {
    text-align: right;
    white-space: nowrap;
  }

  kbd {
    background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17));
    border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,0.4));
    border-radius: 3px;
    padding: 1px 5px;
    font-family: inherit;
    font-size: 11px;
    color: var(--vscode-keybindingLabel-foreground, #ccc);
  }

  .cs-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px 6px;
    border-top: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .cs-note {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    font-style: italic;
    flex: 1;
  }

  .cs-link {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
  }
  .cs-link:hover {
    color: var(--vscode-textLink-activeForeground, #3794ff);
    opacity: 0.8;
  }
</style>
