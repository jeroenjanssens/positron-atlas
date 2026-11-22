<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import PixelImage from './PixelImage.svelte';
  import { formatCount, resolveInvert } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();
  const card = $derived(atlas.pinnedCard);
</script>

{#if card}
  <div class="hover-card" role="dialog" aria-label="Pinned row {card.row}">
    <div class="hc-header">
      <span class="hc-title">
        {#if card.title}<strong>{card.title}</strong>{:else}Row {formatCount(card.row)}{/if}
      </span>
      <button class="hc-close icon-btn" title="Close (Escape)" onclick={() => atlas.closePinnedCard()}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </div>
    {#if card.imageUri}
      <img class="hc-image" class:invert-on={atlas.view.imageInvert === true} class:invert-auto={atlas.view.imageInvert === 'auto'} src={card.imageUri} alt="Row {card.row}" />
    {:else if card.image && atlas.imageShape}
      <PixelImage values={card.image} width={atlas.imageShape[0]} height={atlas.imageShape[1]} invert={resolveInvert(atlas.view.imageInvert)} />
    {/if}
    {#if card.values.length}
      <table class="hc-table">
        <tbody>
          {#each card.values.slice(0, 24) as [k, v]}
            <tr>
              <th>{k}</th>
              <td>
                <span class="hc-val">{v}</span>
                <button class="hc-copy icon-btn" title="Copy" onclick={() => atlas.copyCardValue(v)}>
                  <span class="codicon codicon-copy" aria-hidden="true"></span>
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if card.values.length > 24}
        <div class="hc-more">+ {card.values.length - 24} more columns</div>
      {/if}
    {/if}
    <div class="hc-actions">
      {#if card.linkValue}
        <button class="primary hc-link-btn" onclick={() => atlas.openPinnedLink()} title={card.linkValue}>
          <span class="codicon codicon-link-external" aria-hidden="true"></span>
          Open link
        </button>
      {/if}
      {#if atlas.dims !== 3}
      <button class="hc-annotate-btn" title="Add annotation for this point (A4)"
        onclick={() => { atlas.closePinnedCard(); atlas.addAnnotationFromCard(card); }}>
        <span class="codicon codicon-pin" aria-hidden="true"></span>
        Annotate
      </button>
      {/if}
    </div>
    <div class="hc-hint">Click elsewhere or press Escape to close · Cmd/Ctrl+click to open link</div>
  </div>
{/if}

<style>
  .hover-card {
    position: absolute;
    left: 50%;
    top: 60px;
    transform: translateX(-50%);
    z-index: 8;
    background: var(--tt-bg);
    border: 1px solid var(--tt-border);
    color: var(--tt-fg);
    border-radius: 4px;
    padding: 8px 10px;
    max-width: 400px;
    min-width: 200px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    font-size: 0.9em;
  }
  .hc-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .hc-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted);
    padding: 0 2px;
    display: inline-flex;
    align-items: center;
    line-height: 1;
    flex: none;
  }
  .icon-btn:hover { color: var(--tt-fg); background: none; }
  .hc-close .codicon { font-size: 14px; }
  .hc-image {
    display: block;
    max-width: 100%;
    max-height: 200px;
    object-fit: contain;
    margin: 4px 0 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .hc-table { width: 100%; border-collapse: collapse; }
  .hc-table th {
    text-align: left;
    color: var(--muted);
    font-weight: normal;
    padding-right: 8px;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: top;
    padding-bottom: 2px;
  }
  .hc-table td {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: top;
    padding-bottom: 2px;
  }
  .hc-table tr:hover .hc-copy { opacity: 1; }
  .hc-copy {
    opacity: 0;
    transition: opacity 0.1s;
    font-size: 0.9em;
    vertical-align: middle;
  }
  .hc-copy .codicon { font-size: 12px; }
  .hc-more { color: var(--muted); margin-top: 2px; }
  .hc-link-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.9em;
  }
  .hc-link-btn .codicon { font-size: 13px; }
  .hc-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .hc-annotate-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.9em;
    background: none;
    border: 1px solid var(--border);
    color: var(--tt-fg);
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 2px;
  }
  .hc-annotate-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
  .hc-annotate-btn .codicon { font-size: 13px; }
  .hc-hint { margin-top: 8px; color: var(--muted); font-size: 0.8em; }
</style>
