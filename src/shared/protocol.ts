// Messages exchanged between the extension host and the webview, plus the
// JSON shapes returned by the kernel helper (python/positron_atlas_kernel.py).

export type ColumnKind = 'numeric' | 'bool' | 'datetime' | 'categorical' | 'other';

export interface ColumnInfo {
  index: number;
  name: string;
  dtype: string;
  kind: ColumnKind;
  null_frac: number | null;
  n_unique_est: number | null;
}

export interface DescribeResult {
  ok: true;
  version: string;
  frameKind: 'pandas' | 'polars';
  nRows: number;
  nCols: number;
  columns: ColumnInfo[];
  deps: Record<string, boolean>;
  /** The Rust core: loaded, or why not (numpy is used then). */
  native?: { available: boolean; version?: string; target?: string; reason?: string };
}

export interface PrepareOptions {
  features: number[];
  samplePct: number;
  standardize: boolean;
  pca: boolean;
  pcaDims: number;
  nanPolicy: 'drop' | 'impute';
  seed: number;
  maxAnchors: number;
  anchorBudget: number;
}

export interface PrepareResult {
  nRows: number;
  nSampled: number;
  nKept: number;
  nDropped: number;
  dims: number;
  inputDims: number;
  nAnchors: number;
  needsProjection: boolean;
  explainedVariance: number[] | null;
  featuresBytes: number;
}

export interface KernelOutput {
  kind: 'anchors' | 'anchorPos' | 'xy';
  file: string;
  dtype: 'f32' | 'u16' | 'u32';
  shape: number[];
  offset?: number;
}

export interface JobStatus {
  ok: true;
  jobId: string;
  task: string;
  stage: string;
  progress: number;
  message: string;
  error: string | null;
  result: any;
  outputs: KernelOutput[];
  elapsed: number;
  stale: boolean;
}

export interface FileRef {
  uri: string;
  dtype: 'f32' | 'u16' | 'u32';
  shape: number[];
  offset?: number;
}

export interface NumericColorMeta {
  kind: 'numeric';
  dtype: string;
  isDatetime: boolean;
  min?: number;
  q02?: number;
  median?: number;
  q98?: number;
  max?: number;
  nullCount: number;
}

export interface CategoricalColorMeta {
  kind: 'categorical';
  dtype: string;
  categories: string[];
  counts: number[];
  otherCount: number;
  nullCount: number;
  nUnique: number;
}

export type ColorMeta = NumericColorMeta | CategoricalColorMeta;

/** Exact UMAP on all prepared rows in the kernel. */
export type ExactEngine = 'umap-learn' | 'polars-umap';

export interface UmapParams {
  nNeighbors: number;
  minDist: number;
  spread: number;
  metric: 'euclidean' | 'cosine';
  nEpochs: number;
  seed: number;
  repulsionStrength: number;
  negativeSampleRate: number;
  learningRate: number;
}

export interface Settings {
  maxAnchors: number;
  maxAnchorsCpu: number;
  useWebGpu: boolean;
  anchorBudget: number;
  defaultSamplePct: number;
  pcaEnabled: boolean;
  pcaDims: number;
  /** Use the Rust core for placing rows when available. */
  nativeCore: boolean;
  /** Maximum rows to collect from a lazy frame (polars LazyFrame, DuckDB relation, etc.). */
  maxLazyRows: number;
  /** Memory budget (MB) for the nearest-anchor neighbour cache (P1). */
  neighborCacheMB: number;
}

/** How selected rows differ from all prepared rows (kernel compare_selection). */
export interface SelectionComparison {
  selected: number;
  total: number;
  /** True when the statistics come from a subsample. */
  sampled: boolean;
  /** Largest standardized mean differences, (mean selected − mean all) / std all. */
  numeric: { column: string; isDatetime: boolean; meanSelected: number; meanAll: number; effect: number }[];
  /** Most over-represented categorical values (share in the selection vs. in all rows). */
  categorical: { column: string; value: string; shareSelected: number; shareAll: number; effect: number }[];
}

/** Text labels on the map (Annotate → Labels). */
export interface LabelOptions {
  /** Column whose values label the map, or null for no labels. */
  column: number | null;
  /** Font size range in pixels; size grows with the square root of the group size. */
  minSize: number;
  maxSize: number;
  /** Color the label text like the points when labels and colors use the same column. */
  colorText: boolean;
  /** Label automatic clusters of the layout instead of a column. */
  clusters: boolean;
  /** Cluster detail, 1 (fewer, larger clusters) to 5 (more, smaller ones). */
  detail: number;
  /** Cluster names: numbers, distinguishing features (kernel), or the most common value of a column. */
  nameBy: 'number' | 'features' | number;
  /** Draw cluster outlines. */
  outlines: boolean;

  // ---- A2 label typography ----
  /** Font family name, or '' / undefined to use the editor font. */
  fontFamily?: string;
  /** Base font weight (100–900). Default 600. */
  fontWeight?: number;
  /** Font weight for the smallest-group label (variable-weight "light" end). */
  minFontWeight?: number;
  /** Font weight for the largest-group label (variable-weight "bold" end). */
  maxFontWeight?: number;
  /** Label wrap width in approximate characters (0 = no wrap). */
  wrapWidth?: number;
  /** Line height multiplier for multi-line labels. */
  lineSpacing?: number;
  /** Halo/outline width (0–20). */
  haloWidth?: number;
  /** Halo/outline color as a CSS color string; '' = auto (matches plot background). */
  haloColor?: string;
  /** Letter case: 'asis' keeps the original text, 'upper' applies UPPERCASE. */
  textCase?: 'asis' | 'upper';

  // ---- A3 draggable labels ----
  /** Screen-pixel offsets from each label's automatic position, keyed by group name. */
  dragOffsets?: Record<string, [number, number]>;

  // ---- A8 multi-level labels ----
  /** Second (finer) label column for column labels; enables two-level labels. */
  fineColumn?: number | null;
  /** Enable multi-level clustering (coarse + fine) for cluster labels. */
  multiLevel?: boolean;

  // ---- A9 highlighted label badges ----
  /** Group names to show as filled badges (cluster color background, white bold text). */
  highlightGroups?: string[];
}

/** Tooltip/hover settings (Explore → Tooltip section). */
export interface TooltipOptions {
  /** Column index used as the tooltip title, or null for none. Auto-detected when undefined. */
  titleColumn: number | null | undefined;
  /** Which columns to show in the tooltip fields table. */
  fieldMode: 'none' | 'chosen' | 'all';
  /** Chosen column indices when fieldMode === 'chosen'. */
  fieldColumns: number[];
  /** Column index whose values are URLs/mailto links, or null. Auto-detected when undefined. */
  linkColumn: number | null | undefined;
  /** Column index whose values are image URLs or paths, or null. Auto-detected when undefined. */
  imageUrlColumn: number | null | undefined;
}

/** Title / subtitle / logo overlay options (A1). */
export interface TitleOptions {
  title: string;
  subtitle: string;
  /** Font family name passed to ensureFont(); '' uses the editor font. */
  fontFamily: string;
  /** Title font size in CSS pixels. */
  fontSize: number;
  /** CSS color string; '' follows the theme foreground. */
  color: string;
  /** Logo as a data: URL or empty string. */
  logoData: string;
  /** Logo width in CSS pixels; 0 = auto (48 px). */
  logoWidth: number;
}

/** A single point annotation (A4). */
export interface AnnotationData {
  /** Stable unique id. */
  id: string;
  /** Key by which this annotation is looked up after sorting/filtering.
   *  Row index as a string, or the value of the chosen ID column. */
  rowKey: string;
  /** Original DataFrame row index. */
  row: number;
  /** Text to show in the callout (empty = image annotation). */
  text: string;
  /** Visual style: plain | badge (coloured like the point) | image. */
  style: 'plain' | 'badge' | 'image';
  /** World x coordinate of the annotated point (from the layout at creation time). */
  worldX: number;
  /** World y coordinate of the annotated point. */
  worldY: number;
  /** Screen-pixel x offset from the projected point to the callout box top-left. */
  offsetX: number;
  /** Screen-pixel y offset from the projected point to the callout box top-left. */
  offsetY: number;
  /** Point's color as an rgba() string (used for badge style). */
  color?: string;
  /** Pixel values for image-style annotations — stored so they survive reload without the kernel. */
  imagePixels?: (number | null)[] | null;
  /** Image shape [width, height] in pixels (from atlas.imageShape at creation time). */
  imageShape?: [number, number] | null;
  /** Data-URL thumbnail for image-URL annotations (base64 PNG; '' = not yet fetched). */
  imageDataUrl?: string;
}

/** Persisted in the webview state so tabs can be restored after a reload. */
export interface PanelState {
  variable: string;
  sessionId: string;
  languageId: string;
  prepare?: PrepareOptions;
  umap?: UmapParams;
  colorColumn?: number | null;
  view?: {
    pointSize: number;
    opacity: number;
    mode: 'points' | 'density';
    colormap: string;
    background?: string;
    images?: boolean;
    imageWidth?: number;
    imageInvert?: boolean;
    palette?: 'map' | 'tableau';
  };
  labels?: LabelOptions;
  /** Sidebar tab and the ids of collapsed sections. */
  ui?: { tab?: 'map' | 'explore' | 'annotate' | 'export'; closed?: string[] };
  /** Tooltip settings (H5–H8). */
  tooltip?: TooltipOptions;
  /** Hidden category indices for legend toggles (L1). Keyed by color column index. */
  hiddenCategories?: Record<number, number[]>;
  /** Whether images from URLs are allowed: 'always', 'never', or 'ask' (default). */
  loadImagesFromUrls?: 'always' | 'never' | 'ask';
  /** Title / subtitle / logo overlay (A1). */
  titleOverlay?: TitleOptions;
  /** Point annotations keyed by annotation id (A4). */
  annotations?: Record<string, AnnotationData>;
  /** Column index used as the annotation ID key; null = use row index. */
  annotateIdColumn?: number | null;
}

export type ToWebview =
  | { type: 'init'; variable: string; sessionId: string; describe: DescribeResult; settings: Settings; state?: PanelState }
  | { type: 'status'; task: string; status: JobStatus }
  | { type: 'prepared'; result: PrepareResult; anchors: FileRef; anchorPos: FileRef }
  | { type: 'xyChunk'; file: FileRef; total: number }
  | { type: 'projected'; seconds: number; exact?: boolean; backend?: 'rust' | 'numpy' }
  | { type: 'colors'; column: number; file: FileRef; meta: ColorMeta; length: number }
  | { type: 'labelCodes'; column: number; file: FileRef; meta: ColorMeta; length: number; purpose?: 'labels' | 'names' }
  | { type: 'groupNames'; seq: number; names: string[] }
  | { type: 'labelsWritten'; variable: string; column: string; rows: number; describe: DescribeResult }
  | { type: 'comparison'; seq: number; result: SelectionComparison }
  | { type: 'selectionFrame'; variable: string; rows: number }
  | { type: 'row'; i: number; row: number; values: [string, string][]; image?: (number | null)[] }
  | { type: 'rows'; seq: number; values: Record<number, [string, string][]>; images?: Record<number, (number | null)[]> }
  | { type: 'texts'; column: number; uri: string; offsetsUri: string; count: number }
  | { type: 'imageUri'; row: number; uri: string }
  | { type: 'imagePermission'; granted: boolean }
  | { type: 'error'; message: string; detail?: string; fatal?: boolean }
  | { type: 'coordsAdded'; variable: string; columns: string[] }
  | { type: 'estimate'; seconds: number; rows: number }
  /** Font plumbing (D11). */
  | { type: 'fontReady'; seq: number; family: string; css: string }
  | { type: 'fontError'; seq: number; family: string; message: string }
  | {
      type: 'fontCatalog';
      /** All known font families: bundled ones first, then Google Fonts. */
      families: FontCatalogEntry[];
    }
  /** Search results: kept-row indices that match the query (A7). */
  | { type: 'searchResults'; column: number; query: string; file: FileRef; count: number }
  /** Search returned no matches (A7). */
  | { type: 'searchEmpty'; column: number; query: string }
  /** DataMapPlot export saved to a file (D3/D12). */
  | { type: 'datamapplotSaved'; path: string };

/** Entry in the font catalogue sent to the webview. */
export interface FontCatalogEntry {
  family: string;
  category: 'Serif' | 'Sans Serif' | 'Display' | 'Handwriting' | 'Monospace';
  /** Available weights (static) or weight range (variable). */
  weights: number[] | string;
  /** Where the font file comes from. */
  source: 'bundled' | 'cached' | 'google';
}

export type ToHost =
  | { type: 'ready' }
  | { type: 'prepare'; options: PrepareOptions }
  | { type: 'estimate' }
  | { type: 'project'; anchorXY: Uint8Array /* little-endian float32 */; metric: 'euclidean' | 'cosine'; seed: number }
  | { type: 'exact'; params: UmapParams; engine: ExactEngine }
  | { type: 'colors'; column: number; forceCategorical?: boolean }
  | { type: 'labelCodes'; column: number; maxCategories: number; purpose?: 'labels' | 'names' }
  | { type: 'describeGroups'; seq: number; codes: Uint8Array /* uint16 per prepared row */; k: number; columns: number[] }
  | {
      type: 'writeLabels';
      /** Uint8Array of uint16 per prepared row: i < names.length writes names[i]. */
      codes: Uint8Array;
      names: string[];
      column: string;
      /** Keep the current value of rows without a name (else: missing). */
      keepOthers: boolean;
      /** What is written, for the confirmation (e.g. 'Tag 1,234 rows as "outliers"'). */
      description: string;
    }
  | { type: 'compareSelection'; seq: number; mask: Uint8Array /* packed bits, least significant first */ }
  | { type: 'selectionFrame'; mask: Uint8Array /* packed bits */ }
  | { type: 'row'; i: number; imageColumns?: number[] }
  | { type: 'rows'; seq: number; indices: number[]; columns?: number[]; imageColumns?: number[] }
  | { type: 'texts'; column: number; maxChars: number }
  | { type: 'openLink'; url: string }
  | { type: 'image'; row: number; src: string }
  | { type: 'cancel' }
  | { type: 'addCoordinates'; anchorXY: Uint8Array | null /* float32 */; useProjection: boolean }
  | { type: 'reload' }
  | { type: 'savePng'; bytes: Uint8Array }
  | { type: 'copyText'; text: string }
  | { type: 'state'; state: PanelState }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** Font plumbing (D11). */
  | { type: 'fontRequest'; seq: number; family: string; weights?: number[]; scripts?: string[] }
  | { type: 'fontCatalog' }
  /** Full-screen toggle (N5 / F1). */
  | { type: 'fullscreen'; on: boolean }
  /** Search the title/chosen column for a substring (A7). */
  | { type: 'search'; column: number; query: string; limit: number; regex?: boolean }
  /** Export the map as an interactive DataMapPlot HTML file (D3/D12). */
  | {
      type: 'exportDataMapPlot';
      labelColumn: number | null;
      titleColumn: number | null;
      title?: string;
      /** Raw XY coords from the browser UMAP (Float32, 2 per kept row). */
      anchorXY?: Uint8Array;
      /** Category → hex color when colorColumn === labelColumn (categorical). */
      labelColorMap?: Record<string, string>;
    };
