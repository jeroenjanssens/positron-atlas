import type { UmapParams } from '../shared/protocol';

export const DEFAULT_UMAP: UmapParams = {
  nNeighbors: 15,
  minDist: 0.1,
  spread: 1,
  metric: 'euclidean',
  nEpochs: 200,
  seed: 42,
  repulsionStrength: 1,
  negativeSampleRate: 5,
  learningRate: 1,
};
