<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Atlas } from '../atlas.svelte';

  interface Props {
    atlas: Atlas;
    /** Stable id; the open/closed state persists with the tab. */
    id: string;
    title: string;
    children: Snippet;
  }
  let { atlas, id, title, children }: Props = $props();
  const open = $derived(!atlas.ui.closed.includes(id));
</script>

<details class="group" data-section={id} {open} ontoggle={(e) => atlas.setSectionOpen(id, (e.currentTarget as HTMLDetailsElement).open)}>
  <summary>
    <span class="codicon {open ? 'codicon-chevron-down' : 'codicon-chevron-right'}" aria-hidden="true"></span>
    {title}
  </summary>
  <div class="section">
    {@render children()}
  </div>
</details>
