<script lang="ts">
  import type { Atlas } from '../atlas.svelte';
  import PixelImage from './PixelImage.svelte';
  import { formatCount } from '../logic';

  let { atlas }: { atlas: Atlas } = $props();
  const card = $derived(atlas.pinnedCard);
</script>

{#if card}
  <div class="hover-card" role="dialog" aria-label="Pinned row {card.row}">
    <div class="card-header">
      <span class="card-title">
        {#if card.title}<strong>{card.title}</strong>{:else}Row {formatCount(card.row)}{/if}
      </span>
      <button class="card-close" title="Close (Escape)" onclick={() => atlas.closePinnedCard()}>✕</button>
    </div>
    {#if card.imageUri}
      <img class="card-image" src={card.imageUri} alt="Row {card.row}" />
    {:else if card.image && atlas.imageShape}
      <PixelImage values={card.image} width={atlas.imageShape[0]} height={atlas.imageShape[1]} invert={atlas.view.imageInvert} />
    {/if}
    {#if card.values.length}
      <table class="card-table">
        <tbody>
          {#each card.values.slice(0, 24) as [k, v]}
            <tr>
              <th>{k}</th>
              <td>
                <span class="val-text">{v}</span>
                <button class="copy-btn" title="Copy" onclick={() => atlas.copyCardValue(v)}>⎘</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if card.values.length > 24}
        <div class="card-more">+ {card.values.length - 24} more columns</div>
      {/if}
    {/if}
    {#if card.linkValue}
      <div class="card-actions">
        <button class="card-link primary" onclick={() => atlas.openPinnedLink()} title={card.linkValue}>
          Open link
        </button>
      </div>
    {/if}
    <div class="card-hint">Click elsewhere or press Escape to close · Cmd/Ctrl+click to open link</div>
  </div>
{/if}

<style>
  .hover-card {
    position: absolute;
    left: 50%;
    top: 60px;
    transform: translateX(-50%);
    z-index: 8;
    background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    color: var(--vscode-editorHoverWidget-foreground, var(--fg));
    border-radius: 4px;
    padding: 8px 10px;
    max-width: 400px;
    min-width: 200px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    font-size: 0.9em;
  }
  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .card-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .card-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted, #888);
    padding: 0 2px;
    font-size: 1em;
    line-height: 1;
    flex: none;
  }
  .card-close:hover { color: var(--fg); }
  .card-image {
    display: block;
    max-width: 100%;
    max-height: 200px;
    object-fit: contain;
    margin: 4px 0 8px;
    border: 1px solid var(--border, #333);
    border-radius: 2px;
  }
  .card-table { width: 100%; border-collapse: collapse; }
  .card-table th {
    text-align: left;
    color: var(--muted, #888);
    font-weight: normal;
    padding-right: 8px;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: top;
    padding-bottom: 2px;
  }
  .card-table td {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: top;
    padding-bottom: 2px;
  }
  .card-table tr:hover .copy-btn { opacity: 1; }
  .copy-btn {
    opacity: 0;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted, #888);
    padding: 0 2px;
    font-size: 0.9em;
    vertical-align: middle;
    transition: opacity 0.1s;
  }
  .copy-btn:hover { color: var(--fg); }
  .card-more { color: var(--muted, #888); margin-top: 2px; }
  .card-actions { margin-top: 8px; }
  .card-link { font-size: 0.9em; }
  .card-hint { margin-top: 8px; color: var(--muted, #888); font-size: 0.8em; }
</style>
