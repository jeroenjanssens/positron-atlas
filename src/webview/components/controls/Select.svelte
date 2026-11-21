<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    value?: string;
    ariaLabel?: string;
    title?: string;
    children?: Snippet;
    onchange?: (value: string) => void;
  }
  let { label, value = $bindable(''), ariaLabel, title, children, onchange }: Props = $props();
</script>

<label class="select" {title}>
  <span>{label}</span>
  <select
    {value}
    aria-label={ariaLabel ?? label}
    onchange={(e) => {
      value = (e.target as HTMLSelectElement).value;
      onchange?.(value);
    }}
  >
    {@render children?.()}
  </select>
</label>
