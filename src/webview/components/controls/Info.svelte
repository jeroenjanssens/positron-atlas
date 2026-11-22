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
  let popEl: HTMLDivElement | undefined = $state();
  /** Fixed-position coordinates, so the popover isn't clipped by the scrolling sidebar. */
  let pos = $state({ left: 0, top: 0 });

  const WIDTH = 320;
  const MARGIN = 8;

  function place(): void {
    if (!btnEl) return;
    const r = btnEl.getBoundingClientRect();
    let left = r.right + 6;
    if (left + WIDTH > window.innerWidth - MARGIN) left = Math.max(MARGIN, r.left - WIDTH - 6);
    pos = { left, top: r.top - 4 };
  }

  // Once rendered, keep the popover inside the window vertically.
  $effect(() => {
    if (!visible || !popEl) return;
    const h = popEl.getBoundingClientRect().height;
    const maxTop = window.innerHeight - h - MARGIN;
    if (pos.top > maxTop) pos = { ...pos, top: Math.max(MARGIN, maxTop) };
  });

  const costLabel = (c: string) => (c === 'reprepare' ? 're-prepare' : c);

  const show = () => { place(); visible = true; };
  const hide = () => { if (!pinned) visible = false; };
  const toggle = () => {
    pinned = !pinned;
    if (pinned) place();
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
        bind:this={popEl}
        style="left:{pos.left}px; top:{pos.top}px; width:{WIDTH}px"
        onmouseenter={show}
        onmouseleave={hide}
      >
        <div class="info-title">{entry.title}</div>
        <p class="info-what">{entry.what}</p>
        <p class="info-intuition"><em>Intuition:</em> {entry.intuition}</p>
        {#if entry.when}<p class="info-when"><em>When to change:</em> {entry.when}</p>{/if}
        {#if entry.cost !== 'none'}
          <div class="info-cost">
            <span class="tag {costLabel(entry.cost)}">{costLabel(entry.cost)}</span>
          </div>
        {/if}
      </div>
    {/if}
  </span>
{/if}
