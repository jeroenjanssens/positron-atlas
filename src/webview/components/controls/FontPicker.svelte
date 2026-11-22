<script lang="ts">
  /**
   * FontPicker: searchable combobox for font selection (D11).
   *
   * Sources:
   *  - Editor font (default, always first)
   *  - Bundled fonts (8 families, marked)
   *  - Google Fonts catalogue (~1 960 families, loaded on demand via listFonts())
   *  - Any installed font by name (free-text if no catalogue match)
   */

  import { onMount } from 'svelte';
  import { listFonts } from '../../fonts';
  import type { FontCatalogEntry } from '../../../shared/protocol';

  interface Props {
    value?: string;
    ariaLabel?: string;
    onchange?: (family: string) => void;
  }
  let { value = '', ariaLabel = 'Label font', onchange }: Props = $props();

  type ListEntry = { family: string; label: string; badge?: string };

  // ---- Catalogue ----
  let catalogue: FontCatalogEntry[] = $state([]);
  let catalogueLoaded = $state(false);

  onMount(() => {
    listFonts()
      .then((entries) => {
        catalogue = entries;
        catalogueLoaded = true;
      })
      .catch(() => {
        catalogueLoaded = true; // show bundled only
      });
  });

  // ---- Search state ----
  let query = $state('');
  let open = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLUListElement | undefined = $state();
  let activeIdx = $state(-1);

  // ---- All entries derived from catalogue ----
  const allEntries: ListEntry[] = $derived.by(() => {
    const entries: ListEntry[] = [{ family: '', label: 'Editor font (default)' }];
    if (!catalogueLoaded) {
      const BUNDLED = ['Cinzel', 'Playfair Display SC', 'Marcellus SC', 'Montserrat', 'Roboto', 'Roboto Condensed', 'Inter', 'JetBrains Mono'];
      for (const f of BUNDLED) entries.push({ family: f, label: f, badge: 'bundled' });
    } else {
      const bundled = catalogue.filter((e) => e.source === 'bundled');
      const others = catalogue.filter((e) => e.source !== 'bundled');
      for (const e of bundled) entries.push({ family: e.family, label: e.family, badge: 'bundled' });
      for (const e of others) entries.push({ family: e.family, label: e.family, badge: e.source === 'cached' ? 'cached' : undefined });
    }
    return entries;
  });

  // ---- Filtered entries based on query ----
  const filtered: ListEntry[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allEntries.slice(0, 60);
    const matches = allEntries.filter((e) => e.label.toLowerCase().includes(q));
    // Offer free-text "installed font" entry if no exact match
    const exactMatch = allEntries.some((e) => e.family.toLowerCase() === q);
    if (!exactMatch && query.trim().length > 1) {
      matches.push({ family: query.trim(), label: `Use "${query.trim()}" (installed font)`, badge: 'custom' });
    }
    return matches.slice(0, 80);
  });

  // ---- Helpers ----
  function pick(family: string) {
    query = '';
    open = false;
    activeIdx = -1;
    onchange?.(family);
  }

  function openPicker() {
    query = value || '';
    open = true;
    activeIdx = -1;
    setTimeout(() => inputEl?.select(), 0);
  }

  function onInputFocus() {
    if (!open) openPicker();
  }

  function onInputInput(e: Event) {
    query = (e.target as HTMLInputElement).value;
    open = true;
    activeIdx = -1;
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, filtered.length - 1);
      scrollActiveIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < filtered.length) {
        pick(filtered[activeIdx].family);
      } else if (query.trim()) {
        pick(query.trim());
      }
    } else if (e.key === 'Escape') {
      query = '';
      open = false;
    }
  }

  function scrollActiveIntoView() {
    if (!listEl) return;
    const item = listEl.querySelectorAll('li')[activeIdx];
    item?.scrollIntoView({ block: 'nearest' });
  }

  function onDocClick(e: MouseEvent) {
    const target = e.target as Node;
    const picker = inputEl?.closest('.font-picker');
    if (picker && !picker.contains(target)) {
      query = '';
      open = false;
    }
  }

  const displayText = $derived(value ? value : 'Editor font (default)');
</script>

<svelte:document onclick={onDocClick} />

<div class="font-picker">
  <div class="fp-input-wrap">
    <input
      bind:this={inputEl}
      class="fp-input"
      type="text"
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-autocomplete="list"
      aria-controls="fp-list"
      autocomplete="off"
      spellcheck={false}
      value={open ? query : displayText}
      onfocus={onInputFocus}
      oninput={onInputInput}
      onkeydown={onInputKeydown}
    />
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <span class="fp-chevron codicon codicon-chevron-down" aria-hidden="true" onclick={openPicker}></span>
  </div>
  {#if open}
    <ul bind:this={listEl} id="fp-list" class="fp-list" role="listbox">
      {#if !catalogueLoaded}
        <li role="option" aria-selected={false} aria-disabled="true" class="fp-loading">Loading font catalogue…</li>
      {/if}
      {#each filtered as entry, i (entry.family + '|' + (entry.badge ?? ''))}
        <li
          role="option"
          aria-selected={entry.family === value}
          class:active={i === activeIdx}
          class:selected={entry.family === value}
          onmousedown={(e) => { e.preventDefault(); pick(entry.family); }}
          onmousemove={() => { activeIdx = i; }}
        >
          <span class="fp-name">{entry.label}</span>
          {#if entry.badge}<span class="fp-badge fp-badge-{entry.badge}">{entry.badge}</span>{/if}
        </li>
      {/each}
      {#if filtered.length === 0 && catalogueLoaded}
        <li role="option" aria-selected={false} aria-disabled="true" class="fp-loading">No matches</li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .font-picker {
    position: relative;
    flex: 1;
    max-width: 170px;
    min-width: 0;
  }
  .fp-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .fp-input {
    width: 100%;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 2px 22px 2px 6px;
    font: inherit;
    outline: 1px solid var(--contrast-border);
    cursor: text;
  }
  .fp-input:focus {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .fp-chevron {
    position: absolute;
    right: 5px;
    font-size: 10px;
    color: var(--muted);
    cursor: pointer;
  }
  .fp-list {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    min-width: 200px;
    max-height: 240px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background, #252526);
    border: 1px solid var(--vscode-dropdown-border, #454545);
    border-radius: 4px;
    z-index: 1000;
    list-style: none;
    margin: 0;
    padding: 2px 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
  .fp-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 12px;
    gap: 4px;
    white-space: nowrap;
    overflow: hidden;
  }
  .fp-list li:hover,
  .fp-list li.active {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }
  .fp-list li.selected {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }
  .fp-loading {
    color: var(--muted);
    font-style: italic;
    cursor: default !important;
  }
  .fp-loading:hover { background: none !important; }
  .fp-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fp-badge {
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    opacity: 0.75;
  }
  .fp-badge-bundled {
    background: var(--vscode-badge-background, #3a3d41);
    color: var(--vscode-badge-foreground, #fff);
  }
  .fp-badge-cached {
    background: var(--vscode-charts-green, #4ec9b0);
    color: #000;
  }
  .fp-badge-custom {
    background: var(--vscode-charts-yellow, #d4a017);
    color: #000;
  }
</style>
