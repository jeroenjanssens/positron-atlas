<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    checked?: boolean;
    disabled?: boolean;
    id?: string;
    onchange?: (checked: boolean) => void;
    children?: Snippet;
  }
  let { checked = $bindable(false), disabled = false, id, onchange, children }: Props = $props();

  function onChange(e: Event) {
    checked = (e.target as HTMLInputElement).checked;
    onchange?.(checked);
  }
</script>

<label class="ctrl-check" class:disabled>
  <span class="ctrl-check-box" class:checked aria-hidden="true">
    {#if checked}<span class="codicon codicon-check"></span>{/if}
  </span>
  <input
    type="checkbox"
    {id}
    {checked}
    {disabled}
    onchange={onChange}
    class="sr-only"
  />
  {#if children}{@render children()}{/if}
</label>
