/**
 * Default label options (separated to avoid circular imports).
 */
import type { LabelOptions } from '../../shared/protocol';

/** Default label options. */
export const DEFAULT_LABELS: LabelOptions = {
  column: null,
  minSize: 12,
  maxSize: 26,
  colorText: true,
  clusters: false,
  detail: 2,
  nameBy: 'number',
  outlines: true,
};
