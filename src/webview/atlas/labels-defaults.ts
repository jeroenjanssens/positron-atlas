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
  // A2 typography
  fontFamily: '',
  fontWeight: 600,
  minFontWeight: 400,
  maxFontWeight: 700,
  wrapWidth: 9,
  lineSpacing: 0.95,
  haloWidth: 10,
  haloColor: '',
  textCase: 'asis',
  // A3 draggable
  dragOffsets: {},
  // A8 multi-level
  fineColumn: null,
  multiLevel: false,
  // A9 highlighted
  highlightGroups: [],
};
