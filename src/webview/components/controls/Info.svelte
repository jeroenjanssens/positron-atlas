<script lang="ts">
  /**
   * Info button placeholder (wave 0: renders nothing).
   * Wave 1 will add a popover with help text keyed by `id`.
   */
  interface Props {
    id: string;
  }
  let { id = '' }: Props = $props();
</script>

<!-- wave 1: ⓘ popover for {id} -->
