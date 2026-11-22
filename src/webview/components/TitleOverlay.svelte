<script lang="ts">
  import type { Atlas } from '../atlas.svelte';

  let { atlas }: { atlas: Atlas } = $props();
  const opts = $derived(atlas.titleOverlay);

  const hasContent = $derived(opts.title.trim() || opts.subtitle.trim() || opts.logoData);

  const titleStyle = $derived(() => {
    const parts: string[] = [];
    if (opts.fontFamily) parts.push(`font-family: '${opts.fontFamily}', sans-serif`);
    if (opts.fontSize) parts.push(`font-size: ${opts.fontSize}px`);
    if (opts.color) parts.push(`color: ${opts.color}`);
    return parts.join('; ');
  });
  const subtitleStyle = $derived(() => {
    const parts: string[] = [];
    if (opts.fontFamily) parts.push(`font-family: '${opts.fontFamily}', sans-serif`);
    const sz = Math.round((opts.fontSize || 24) * 0.6);
    parts.push(`font-size: ${sz}px`);
    if (opts.color) parts.push(`color: ${opts.color}`);
    return parts.join('; ');
  });
  const logoW = $derived(opts.logoWidth > 0 ? opts.logoWidth : 48);
</script>

{#if hasContent}
  <div class="title-overlay" aria-label="Map title">
    {#if opts.logoData}
      <img class="logo" src={opts.logoData} alt="Logo" width={logoW} style="max-width:{logoW}px" />
    {/if}
    {#if opts.title.trim()}
      <div class="map-title" style={titleStyle()}>{opts.title}</div>
    {/if}
    {#if opts.subtitle.trim()}
      <div class="map-subtitle" style={subtitleStyle()}>{opts.subtitle}</div>
    {/if}
  </div>
{/if}

<style>
  .title-overlay {
    position: absolute;
    top: 36px;
    left: 12px;
    z-index: 5;
    pointer-events: none;
    max-width: 40%;
  }
  .logo {
    display: block;
    margin-bottom: 6px;
    object-fit: contain;
  }
  .map-title {
    font-size: 24px;
    font-weight: 700;
    color: var(--vscode-editor-foreground, #cccccc);
    line-height: 1.1;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6), 0 0 2px rgba(0,0,0,0.9);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .map-subtitle {
    font-size: 14px;
    font-weight: 400;
    color: var(--vscode-editor-foreground, #cccccc);
    opacity: 0.75;
    margin-top: 2px;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
