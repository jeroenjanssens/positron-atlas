/**
 * Shared types, interfaces and constants for the Atlas module.
 * Imported by atlas.svelte.ts and all atlas/* sub-modules.
 */

export interface ViewOptions {
  pointSize: number;
  opacity: number;
  mode: 'points' | 'density';
  colormap: string;
  /** Plot background as a hex color; '' follows the theme's editor background. */
  background: string;
  /** Show each row as an image in the hover tooltip. */
  images: boolean;
  /** Image width in pixels; 0 = automatic (square). */
  imageWidth: number;
  /** Swap dark and light in the image thumbnails. */
  imageInvert: boolean;
  /** Categorical colors: 'map' follows the layout, 'tableau' is Tableau 20, 'cvd' is colour-vision-safer. */
  palette: 'map' | 'tableau' | 'cvd';
  // ---- A12 glow ----
  /** Show a blurred density halo around each cluster/category group (A12). */
  glow?: boolean;
  /** Glow opacity/strength, 0–1 (default 0.4). */
  glowStrength?: number;
  /** Glow blur radius in CSS pixels (default 40). */
  glowRadius?: number;
}

export type Phase = 'loading' | 'preparing' | 'embedding' | 'ready' | 'error';

export type SidebarTab = 'map' | 'explore' | 'annotate' | 'export';

export interface UiState {
  tab: SidebarTab;
  /** Ids of collapsed sidebar sections. */
  closed: string[];
}

/** Auto-place all rows after UMAP when the estimate is below this many seconds. */
export const AUTO_PROJECT_SECONDS = 20;

/** Most categories of a label column that get a label (the rest are not labeled). */
export const MAX_LABELS = 200;

/** Recompute label positions at most this often while the layout animates (ms). */
export const LABEL_INTERVAL_MS = 250;
