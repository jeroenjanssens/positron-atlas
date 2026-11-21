<script lang="ts">
  interface Props {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    /** CSS class added to the <input> (default: "num"). */
    class?: string;
    ariaLabel?: string;
    onchange?: (value: number) => void;
    oninput?: (value: number) => void;
  }
  let {
    value = $bindable(0),
    min,
    max,
    step,
    disabled = false,
    class: cls = 'num',
    ariaLabel,
    onchange,
    oninput,
  }: Props = $props();
</script>

<input
  class={cls}
  type="number"
  {min}
  {max}
  {step}
  {value}
  {disabled}
  aria-label={ariaLabel}
  onchange={(e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) {
      value = v;
      onchange?.(v);
    }
  }}
  oninput={(e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) {
      value = v;
      oninput?.(v);
    }
  }}
/>
