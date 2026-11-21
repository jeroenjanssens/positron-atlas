<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    value?: string | number;
    disabled?: boolean;
    ariaLabel?: string;
    onchange?: (e: Event) => void;
    children?: Snippet;
  }
  let { value, disabled = false, ariaLabel, onchange, children }: Props = $props();
</script>

<div class="ctrl-select-wrap">
  <select
    class="ctrl-select"
    {value}
    {disabled}
    aria-label={ariaLabel}
    onchange={onchange}
  >
    {#if children}{@render children()}{/if}
  </select>
  <span class="ctrl-select-chevron codicon codicon-chevron-down" aria-hidden="true"></span>
</div>
