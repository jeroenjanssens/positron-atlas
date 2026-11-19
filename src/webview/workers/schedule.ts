// Port of embedding-atlas umap/src/layout_modern.rs `learning_rate_at` for the Adam
// optimizer with a good (spectral) initialization, so that stepping one epoch at a
// time anneals exactly like `umap.run()` would.

function adamLearningRate(epoch: number, nEpochs: number, peak: number, warmUp: number): number {
  if (epoch < warmUp) {
    return (peak - 0.1) * Math.pow(1 - epoch / warmUp, 2) + 0.1;
  }
  return 0.15 * (1 - (epoch - warmUp) / (nEpochs - warmUp)) + 0.05;
}

export function adamRate(epoch: number, nEpochs: number, alpha0 = 1): number {
  const total = Math.max(1, nEpochs);
  const e = Math.min(Math.max(0, epoch), total - 1);
  return adamLearningRate(e, total, 0.5 * alpha0, Math.floor(Math.min(total / 8, 100)));
}
