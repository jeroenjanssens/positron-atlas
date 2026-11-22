<script lang="ts">
  import { onMount } from 'svelte';
  import type { Atlas } from '../atlas.svelte';

  let { atlas }: { atlas: Atlas } = $props();

  function dismiss() {
    atlas.hintSeen();
  }

  onMount(() => {
    const t = setTimeout(dismiss, 4000);
    return () => clearTimeout(t);
  });
</script>

<div class="nav-hint" role="status" aria-live="polite">
  Press <kbd>?</kbd> for controls
  <button class="nav-hint-close" onclick={dismiss} aria-label="Dismiss hint">×</button>
</div>

<style>
  .nav-hint {
    position: absolute;
    bottom: 48px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-notifications-background, #252526);
    color: var(--vscode-notifications-foreground, #ccc);
    border: 1px solid var(--vscode-notifications-border, #474747);
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 12px;
    z-index: 90;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    animation: fade-in 0.3s ease;
  }
  .nav-hint-close {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font-size: 14px;
    line-height: 1;
    opacity: 0.7;
  }
  .nav-hint-close:hover { opacity: 1; }
  kbd {
    background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17));
    border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,0.4));
    border-radius: 3px;
    padding: 1px 5px;
    font-family: inherit;
    font-size: 11px;
  }
  @keyframes fade-in {
    from { opacity: 0; transform: translateX(-50%) translateY(4px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
