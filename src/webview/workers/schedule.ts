// Learning-rate schedule for stepping the published embedding-atlas UMAP (SGD
// optimizer) one epoch at a time. This is umap-learn's classic linear decay
// alpha = alpha0 * (1 - epoch / n_epochs), which is what `umap.run()` uses for SGD.

export function sgdRate(epoch: number, nEpochs: number, alpha0 = 1): number {
  const total = Math.max(1, nEpochs);
  const e = Math.min(Math.max(0, epoch), total);
  return Math.max(0, alpha0 * (1 - e / total));
}
