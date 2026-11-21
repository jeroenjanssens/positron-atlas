<script lang="ts">
  interface Props {
    label: string;
    checked?: boolean;
    disabled?: boolean;
    title?: string;
    /** Called when the value changes. */
    onchange?: (checked: boolean) => void;
  }
  let { label, checked = $bindable(false), disabled = false, title, onchange }: Props = $props();
</script>

<label class="check" {title}>
  <input
    type="checkbox"
    {checked}
    {disabled}
    onchange={(e) => {
      checked = (e.target as HTMLInputElement).checked;
      onchange?.(checked);
    }}
  />
  {label}
</label>
