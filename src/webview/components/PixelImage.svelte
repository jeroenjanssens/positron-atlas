<script lang="ts">
  import { imageToRgba } from '../logic';

  let { values, width, height, invert = false, size = 140 }: { values: (number | null)[]; width: number; height: number; invert?: boolean; size?: number } = $props();
  let canvas: HTMLCanvasElement;

  $effect(() => {
    const g = canvas.getContext('2d');
    if (!g || width <= 0 || height <= 0) return;
    canvas.width = width;
    canvas.height = height;
    g.putImageData(new ImageData(imageToRgba(values, width, height, invert), width, height), 0, 0);
  });

  const scale = $derived(Math.max(1, Math.floor(size / Math.max(width, height))));
</script>

<canvas bind:this={canvas} class="pixel-image" class:inverted={invert} style:width="{width * scale}px" style:height="{height * scale}px" aria-label="Row image"></canvas>
