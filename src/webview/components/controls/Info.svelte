<script lang="ts">
  import { getHelp } from '../../help';

  interface Props {
    id: string;
    /** Optional aria-describedby target id on the control this Info belongs to. */
    controlId?: string;
  }
  let { id, controlId }: Props = $props();

  const entry = $derived(getHelp(id));
  let pinned = $state(false);
  let visible = $state(false);
  let btnEl: HTMLButtonElement | undefined = $state();

  const show = () => { visible = true; };
  const hide = () => { if (!pinned) visible = false; };
  const toggle = () => {
    pinned = !pinned;
    visible = pinned;
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      pinned = false;
      visible = false;
      btnEl?.focus();
    }
  }

  // Also listen at document level so Escape always closes the pinned popover
  // regardless of which element currently has focus.
  function onDocKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && (visible || pinned)) {
      pinned = false;
      visible = false;
    }
  }
</script>

<svelte:document onkeydown={onDocKeyDown} />

{#if entry}
  <span class="info-wrap" id={controlId ? `info-${controlId}` : undefined}>
    <button
      bind:this={btnEl}
      class="info-btn"
      class:pinned
      aria-label="Help: {entry.title}"
      aria-expanded={visible}
      aria-haspopup="true"
      title={entry.title}
      onmouseenter={show}
      onmouseleave={hide}
      onfocus={show}
      onblur={hide}
      onclick={toggle}
      onkeydown={onKeyDown}
    >
      <span class="codicon codicon-info" aria-hidden="true"></span>
    </button>
    {#if visible}
      <div
        class="info-popover"
        role="tooltip"
        onmouseenter={show}
        onmouseleave={hide}
      >
        <div class="info-title">{entry.title}</div>
        <p class="info-what">{entry.what}</p>
        <p class="info-intuition"><em>Why:</em> {entry.intuition}</p>
        {#if entry.when}<p class="info-when"><em>When to change:</em> {entry.when}</p>{/if}
        {#if entry.cost !== 'none'}
          <div class="info-cost">
            <span class="tag {entry.cost}">{entry.cost}</span>
          </div>
        {/if}
      </div>
    {/if}
  </span>
{/if}
