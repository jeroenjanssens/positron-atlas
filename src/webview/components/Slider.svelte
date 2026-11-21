<script lang="ts">
  import Info from './controls/Info.svelte';

  interface Props {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    hint?: string;
    tag?: 'live' | 'rebuild' | 'apply';
    disabled?: boolean;
    infoId?: string;
    /** Called while dragging (debounced) when live, else on release. */
    onchange?: (v: number) => void;
    format?: (v: number) => string;
  }
  let { label, value = $bindable(), min, max, step = 1, hint, tag, disabled = false, infoId, onchange, format }: Props = $props();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function input(e: Event) {
    value = Number((e.target as HTMLInputElement).value);
    if (tag === 'live') {
      clearTimeout(timer);
      timer = setTimeout(() => onchange?.(value), 120);
    }
  }
  function commit(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    value = Math.min(max, Math.max(min, v));
    clearTimeout(timer);
    onchange?.(value);
  }
</script>

<label class="slider" class:disabled title={hint}>
  <span class="row">
    <span class="name">{label}{#if tag}<span class="tag {tag}">{tag}</span>{/if}{#if infoId}<Info id={infoId} />{/if}</span>
    <input class="num" type="number" {min} {max} {step} {value} {disabled} onchange={commit} />
  </span>
  <input type="range" {min} {max} {step} {value} {disabled} oninput={input} onchange={commit} aria-label={label} />
  {#if format}<span class="fmt">{format(value)}</span>{/if}
</label>
