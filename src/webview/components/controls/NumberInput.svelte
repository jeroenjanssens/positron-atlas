<script lang="ts">
  interface Props {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    wide?: boolean;
    ariaLabel?: string;
    onchange?: (e: Event) => void;
    oninput?: (e: Event) => void;
  }
  let { value = $bindable(0), min, max, step, disabled = false, wide = false, ariaLabel, onchange, oninput }: Props = $props();
</script>

<input
  class="ctrl-num"
  class:wide
  type="number"
  {value}
  {min}
  {max}
  {step}
  {disabled}
  aria-label={ariaLabel}
  {onchange}
  {oninput}
/>
