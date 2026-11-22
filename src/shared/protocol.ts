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
  /** When set, use these columns as x/y[/z] layout coordinates instead of running UMAP. */
  coordsColumns?: { x: number; y: number; z?: number } | null;
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
  /** True when layout comes from precomputed coordinate columns (no UMAP). */
  coordsMode?: boolean;
}

export interface KernelOutput {
  kind: 'anchors' | 'anchorPos' | 'xy' | 'overlayXy';
  file: string;
  dtype: 'f32' | 'u16' | 'u32';
  shape: number[];
  offset?: number;
  /** B3: overlay layer id; present when kind === 'overlayXy'. */
  layerId?: string;
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

/** Metadata for a size-by-column attribute (A10). */
export interface SizeMeta {
  kind: 'numeric';
  min: number;
  /** 1st percentile (used as low clamp). */
  q01: number;
  /** 99th percentile (used as high clamp). */
  q99: number;
  max: number;
  nullCount: number;
}

/** Pre-computed histogram bins for a numeric or date column (A13). */
export interface HistogramData {
  /** n+1 bin edges (uniform or date-aware). */
  edges: number[];
  /** n bin counts (all prepared rows, before filter). */
  counts: number[];
  /** True when the column is a datetime (edges are ms since epoch). */
  isDatetime: boolean;
}

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

/** Navigation / input settings (A1 wave, item 1). */
export interface NavigationSettings {
  /** Navigation interaction preset. */
  preset: 'dataMap' | 'molecular' | 'cad' | 'design';
  /** What scroll gesture does (zoom vs pan). */
  scrollGesture: 'zoom' | 'pan';
  /** Zoom toward the cursor position when true. */
  zoomToCursor: boolean;
  /** Reverse the scroll-to-zoom direction. */
  invertZoom: boolean;
  /** Treat Alt+left-drag as middle-button drag (emulates three-button mouse). */
  emulateMiddleButton: boolean;
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
  /** Navigation / input settings (A1 wave, item 1). */
  nav: NavigationSettings;
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
  /**
   * Outline style for group boundaries (B2).
   * 'hull' = convex hull polygon (2D only, default).
   * 'box'  = axis-aligned bounding box (2D and 3D).
   * In 3D the box is the only option (hulls are 2D-only).
   */
  outlineStyle?: 'hull' | 'box';

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
  /**
   * Map-coordinate (world) offsets from each label's automatic position, keyed by group name.
   * Q11 (B5): stored in world units so they stay correct under pan, zoom, rotation and in 3D.
   * Legacy screen-pixel offsets (before B5) are reset on load when dragOffsetsVersion is absent.
   */
  dragOffsets?: Record<string, [number, number]>;
  /**
   * When present and equal to 'v2map', dragOffsets are in map coordinates (world units).
   * Absent in legacy saves (< B5), which used screen pixels — reset to {} on load.
   */
  dragOffsetsVersion?: 'v2map';

  // ---- A8 multi-level labels ----
  /** Second (finer) label column for column labels; enables two-level labels. */
  fineColumn?: number | null;
  /** Enable multi-level clustering (coarse + fine) for cluster labels. */
  multiLevel?: boolean;

  // ---- A9 highlighted label badges ----
  /** Group names to show as filled badges (cluster color background, white bold text). */
  highlightGroups?: string[];

  // ---- A11 labels around the map ----
  /** Where to place labels: 'over' (default, inside the cloud) or 'around' (outside with leader lines). */
  labelStyle?: 'over' | 'around';
  /** Leader line style for around-the-map labels. */
  leaderStyle?: 'straight' | 'curved' | 'wedge';
  /** Leader line color: 'cluster' matches the group color, 'grey' is a neutral grey. */
  leaderColor?: 'cluster' | 'grey';
  /** Leader line width in CSS pixels. */
  leaderWidth?: number;
  /**
   * Frozen around-the-map layout: when set, the around-label overlay uses these absolute
   * world positions instead of the auto-computed ring positions (Q14 freeze layout).
   * Keyed by group name; value is [worldX, worldY].
   */
  frozenAroundLayout?: Record<string, [number, number]>;

  // ---- B5 scale text with zoom ----
  /**
   * When true, label text scales with zoom (sizeUnits: 'common'), giving figure-like behaviour.
   * Default: false (pixel-size labels are readable at every zoom level, like online maps).
   * Q13 decision.
   */
  scaleTextWithZoom?: boolean;
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
  /** World z coordinate of the annotated point (3D mode only; absent or 0 in 2D). */
  worldZ?: number;
  /**
   * Map-coordinate (world-unit) x offset from the annotated point to the callout box anchor.
   * Q12 (B5): box position = projectWorld(worldX + offsetX, worldY + offsetY).
   * Legacy saves (before B5, offsetVersion absent) used screen pixels — reset on load.
   */
  offsetX: number;
  /**
   * Map-coordinate (world-unit) y offset from the annotated point to the callout box anchor.
   * World y is up, so a positive offsetY moves the box upward on screen.
   */
  offsetY: number;
  /**
   * When present and equal to 'v2map', offsetX/Y are in map coordinates.
   * Absent in legacy saves (< B5), which used screen pixels — reset to default on load.
   */
  offsetVersion?: 'v2map';
  /** Point's color as an rgba() string (used for badge style). */
  color?: string;
  /** Pixel values for image-style annotations — stored so they survive reload without the kernel. */
  imagePixels?: (number | null)[] | null;
  /** Image shape [width, height] in pixels (from atlas.imageShape at creation time). */
  imageShape?: [number, number] | null;
  /** Data-URL thumbnail for image-URL annotations (base64 PNG; '' = not yet fetched). */
  imageDataUrl?: string;
  /**
   * Q12 (B5): when true, the callout box is clamped to within 200 px of the annotated point
   * on screen. Useful when zoomed far out so the box doesn't float too far from its point.
   */
  clampToAnchor?: boolean;
}

/** Persisted in the webview state so tabs can be restored after a reload. */
export interface PanelState {
  variable: string;
  sessionId: string;
  languageId: string;
  prepare?: PrepareOptions;
  umap?: UmapParams;
  /** Output dimensionality of the UMAP layout: 2 (default) or 3 (T2). */
  dims?: 2 | 3;
  /** Layout mode: 'umap' (default) or 'columns' (precomputed coordinate columns). */
  layoutMode?: 'umap' | 'columns';
  colorColumn?: number | null;
  view?: {
    pointSize: number;
    opacity: number;
    mode: 'points' | 'density';
    colormap: string;
    background?: string;
    images?: boolean;
    imageWidth?: number;
    imageInvert?: boolean | 'auto';
    palette?: 'map' | 'tableau' | 'cvd';
    // A12 glow
    glow?: boolean;
    glowStrength?: number;
    glowRadius?: number;
    // item 13: 3D view options
    show3DDataBox?: boolean;
    show3DFloorGrid?: boolean;
    show3DGizmo?: boolean;
    orthographic3D?: boolean;
    depthFade?: boolean;
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
  /** True when coloring by automatic cluster codes (A6). */
  colorByCluster?: boolean;
  /** Column index used for size-by-column (A10), or null for uniform size. */
  sizeColumn?: number | null;
  /** Active histogram brush range for the filter (A13): [lo, hi] of the column value. */
  histFilter?: { column: number; range: [number, number] } | null;
  /** Point-layer visibility and display overrides (A2). */
  layers?: {
    id: string;
    kind: 'base' | 'overlay-frame';
    name: string;
    visible: boolean;
    opacity: number;
    blending: 'normal' | 'additive';
    order: number;
  }[];
  /** 2D map rotation angle in degrees (item 14). 0 = north-up. */
  rotation2D?: number;
  /** Shapes on the map (item 8, B4).  Versioned JSON.  Stored as a plain object so the
   *  panel serialiser can include it without importing the shapes module. */
  shapes?: unknown;
  /** Brush tool class names (item 7, B4). */
  brushClasses?: string[];
  /** Time-slider animation options (C2, item 10). */
  animate?: AnimateOptions;
  /** Tracks options (C2, item 11). */
  tracks?: TracksOptions;
}

/** A user-overridden keybinding from keybindings.json (item 2 cheat sheet). */
export interface UserKeybinding {
  /** VS Code command id (e.g. 'positronAtlas.nav.view.reset'). */
  command: string;
  /** Key chord string as it appears in keybindings.json (e.g. 'ctrl+r'). */
  key: string;
}

export type ToWebview =
  | {
      type: 'init';
      variable: string;
      sessionId: string;
      describe: DescribeResult;
      settings: Settings;
      state?: PanelState;
      /** Host OS: 'darwin' | 'win32' | 'linux'. Used by the cheat sheet for key notation (item 2). */
      platform: string;
      /** Atlas keybindings from the user's keybindings.json, or null when unavailable. */
      userKeybindings: UserKeybinding[] | null;
      /** True on first run (before globalState 'atlasHintShownV1' is set). */
      showHint?: boolean;
    }
  | { type: 'status'; task: string; status: JobStatus }
  | { type: 'prepared'; result: PrepareResult; anchors: FileRef; anchorPos: FileRef }
  | { type: 'xyChunk'; file: FileRef; total: number; layerId?: string }
  | { type: 'projected'; seconds: number; exact?: boolean; backend?: 'rust' | 'numpy' }
  | { type: 'colors'; column: number; file: FileRef; meta: ColorMeta; length: number }
  | { type: 'labelCodes'; column: number; file: FileRef; meta: ColorMeta; length: number; purpose?: 'labels' | 'names' }
  /** Size-by-column values (A10): float32 per kept row. */
  | { type: 'sizes'; column: number; file: FileRef; meta: SizeMeta }
  /** Raw float32 column values for histogram filter (A13). */
  | { type: 'histValues'; column: number; file: FileRef }
  /** Pre-computed histogram bins for a column (A13). */
  | { type: 'histogram'; column: number; data: HistogramData }
  /** Anchor XY from kernel polars-umap (P3): float32[nAnchors*2]. */
  | { type: 'anchorXY'; file: FileRef; seconds: number }
  | { type: 'groupNames'; seq: number; names: string[] }
  | { type: 'labelsWritten'; variable: string; column: string; rows: number; describe: DescribeResult }
  | { type: 'comparison'; seq: number; result: SelectionComparison }
  | { type: 'selectionFrame'; variable: string; rows: number; overlayFrames?: { variable: string; rows: number }[] }
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
  /** Forward a VS Code command to the webview (item 1). */
  | { type: 'command'; id: string }
  /** Navigation settings changed (item 1). */
  | { type: 'settingsChanged'; nav: NavigationSettings }
  /** DataMapPlot export saved to a file (D3/D12). */
  | { type: 'datamapplotSaved'; path: string }
  /** HTML export saved to a file (X2). path = '' on harness (written to job dir). */
  | { type: 'htmlExportSaved'; path: string }
  /**
   * A command from the Python API (C3).
   * The webview applies it and replies with `apiReply` (ToHost).
   * Valid command names: 'colorBy', 'labelBy', 'setDims', 'annotate', 'savePng', 'saveHtml', 'close'.
   */
  | {
      type: 'apiCommand';
      commandId: string;
      name: string;
      args: Record<string, unknown>;
    }
  /**
   * Sent by the host in response to `exportHtml` (X2).
   * Contains kernel-fetched text and the URI the webview should fetch for the viewer bundle.
   */
  /** B3: overlay prepare completed (kernel applied transforms; host can now call project_overlay). */
  | { type: 'overlayPrepared'; layerId: string; variable: string; nRows: number; nKept: number; dims: number }
  /** B3: overlay layer removed from the kernel job. */
  | { type: 'overlayRemoved'; layerId: string }
  /** B3: row values fetched from an overlay layer for hover/pin cards. */
  | { type: 'overlayRows'; seq: number; layerId: string; values: Record<number, [string, string][]> }
  /** B3/Item 9: u16 category codes + category names for symbol-by-column. */
  | { type: 'symbolCodes'; column: number; file: FileRef; categories: string[] }
  /** B3: column descriptions for an overlay variable. */
  | { type: 'overlayDescribe'; layerId: string; columns: ColumnInfo[] }
  /** B3: position indices in the overlay that match a search query. */
  | { type: 'searchOverlayResults'; layerId: string; query: string; file: FileRef; count: number }
  /** B3: overlay search returned no matches. */
  | { type: 'searchOverlayEmpty'; layerId: string; query: string }
  /** B3: float32 column values for histogram filter on an overlay layer. */
  | { type: 'histValuesOverlay'; layerId: string; column: number; file: FileRef }
  | {
      type: 'exportHtmlAssembly';
      /**
       * URI for the viewer JS bundle.
       * In Positron this is a vscode-resource: URI; in the harness it is `/viewer-dist/viewer.js`.
       */
      viewerJsUri: string;
      /** Concatenated UTF-8 text for all tooltip columns (or null when no text requested). */
      textUtf8: Uint8Array | null;
      /** u32[(nPoints+1)*nCols] offsets into textUtf8 (or null). */
      textOffsets: Uint32Array | null;
    }
  // ---- C2: Animate responses (host → webview) ------------------------------------
  /** Normalised float32 values for the animate filter column, plus min/max. */
  | { type: 'timeValues'; column: number; file: FileRef; min: number; max: number; length: number }
  /** Tracks binary files result (C2, item 11). */
  | { type: 'tracks'; result: TracksResult }
  /** Video file was saved (C2, item 10). */
  | { type: 'videoSaved'; path: string };

/** Reply sent by the webview after applying a Python API command (C3). */
export interface ApiReplyMsg {
  type: 'apiReply';
  commandId: string;
  ok: boolean;
  error?: string;
  /** PNG bytes for savePng commands. */
  bytes?: Uint8Array;
}

// ---- C2: Animate by column (item 10) -------------------------------------------

/** Options for the "Animate by" time slider (C2, item 10). */
export interface AnimateOptions {
  /** Column index to animate by, or null when not set. */
  column: number | null;
  /** Normalised [0, 1] position of the leading edge of the animation window. */
  windowPos: number;
  /** Normalised [0, 1] width of the animation window. */
  windowSize: number;
  /** Playback speed (window lengths per second). */
  speed: number;
  /** Loop when the window reaches the end. */
  loop: boolean;
}

// ---- C2: Tracks and vectors (item 11) ------------------------------------------

/** Options for the "Connect rows by" (tracks) feature (C2, item 11). */
export interface TracksOptions {
  /** Column index used as the track ID, or null when not set. */
  idColumn: number | null;
  /** Column index used to order points within each track, or null. */
  timeColumn: number | null;
  /** How to colour track lines. */
  colorBy: 'id' | 'time';
  /** Fade the track from dim (early) to bright (late). */
  fadingTail: boolean;
}

/** Binary files produced by the kernel `tracks` task (C2, item 11). */
export interface TracksResult {
  /** f32 file: interleaved x,y (2D) or x,y,z (3D) per point. */
  xyFile: FileRef;
  /** u32 file: start index per track (into the flat xy/time/id arrays). */
  startsFile: FileRef;
  /** u32 file: point count per track. */
  lengthsFile: FileRef;
  /** f32 file: normalised time value per point (0–1). */
  timeFile: FileRef;
  /** u16 file: numeric track-id index per point (index into idCategories). */
  idFile: FileRef;
  /** Flat RGBA color per track (nTracks * 4 bytes), from a qualitative palette. */
  idColors: number[];
  /** Number of distinct tracks. */
  nTracks: number;
  /** Total number of points across all tracks. */
  nPoints: number;
  /** Position dimensionality: 2 (2D layout) or 3 (3D layout). */
  nd: 2 | 3;
}

/** Options for video export (C2, item 10). */
export interface VideoExportOptions {
  /** Export mode: time animation, 3D turntable, or UMAP converging. */
  mode: 'time' | 'turntable' | 'umap';
  widthPx: number;
  heightPx: number;
  fps: number;
  /** Recording duration in seconds (default 3). */
  durationSecs?: number;
}

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
  | { type: 'project'; anchorXY: Uint8Array /* little-endian float32 */; metric: 'euclidean' | 'cosine'; seed: number; dims?: 2 | 3 }
  | { type: 'exact'; params: UmapParams; engine: ExactEngine; dims?: 2 | 3 }
  | { type: 'colors'; column: number; forceCategorical?: boolean }
  | { type: 'labelCodes'; column: number; maxCategories: number; purpose?: 'labels' | 'names' }
  /** Request float32 size values for a column (A10). */
  | { type: 'sizes'; column: number }
  /** Request float32 column values for the histogram filter (A13). */
  | { type: 'histValues'; column: number }
  /** Request a histogram for a numeric/date column (A13). */
  | { type: 'histogram'; column: number; nBins?: number }
  /** Request anchor-only UMAP via polars-umap in the kernel (P3). */
  | { type: 'anchorUmap'; params: UmapParams; dims?: 2 | 3 }
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
  | {
      type: 'selectionFrame';
      mask: Uint8Array /* packed bits over base rows */;
      /** B3: per-overlay-layer selection masks (packed bits over overlay rows). */
      overlayMasks?: { layerId: string; variable: string; mask: Uint8Array }[];
    }
  | { type: 'row'; i: number; imageColumns?: number[] }
  | { type: 'rows'; seq: number; indices: number[]; columns?: number[]; imageColumns?: number[] }
  | { type: 'texts'; column: number; maxChars: number }
  | { type: 'openLink'; url: string }
  /** Execute a VS Code command from the webview (item 2 cheat sheet links). */
  | { type: 'openCommand'; command: string; args?: unknown[] }
  | { type: 'image'; row: number; src: string }
  | { type: 'cancel' }
  | { type: 'addCoordinates'; anchorXY: Uint8Array | null /* float32 */; useProjection: boolean; dims?: 2 | 3 }
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
    }
  /**
   * Export the map as a self-contained HTML file (X2).
   *
   * Visual arrays stay in the webview; only metadata goes to the host so it can
   * fetch kernel text and return a viewer-bundle URI.  The host responds with
   * `exportHtmlAssembly` (ToWebview), and the webview assembles + posts back
   * `exportHtmlReady` with the final bytes.
   */
  | {
      type: 'exportHtml';
      /** Number of data points (used for text fetch). */
      nPoints: number;
      /** DataFrame variable name (for the save-dialog default path). */
      variable: string;
      /** Columns to embed as tooltip text (index + display name). */
      tooltipColumns: { index: number; name: string; isLink?: boolean; isTitle?: boolean }[];
      /** Max characters per tooltip cell. */
      maxChars: number;
      /** Sampling info for the blob header. */
      samplePct: number;
      total: number;
      sampled: number;
    }
  // ---- C2: Time slider (item 10) -----------------------------------------------
  /** Request normalised float32 column values for the animate filter (C2). */
  | { type: 'timeValues'; column: number }
  /** Request tracks (group-by-ID, sort-by-time, 5 binary files) (C2, item 11).
   * anchorXY is included so the kernel can use it when job.xy is not set
   * (e.g. browser-side UMAP with needsProjection=false). */
  | { type: 'tracks'; idColumn: number; timeColumn: number; nd: 2 | 3; anchorXY?: Uint8Array | string }
  /** Save a video clip to a .webm file (C2, item 10). */
  | { type: 'saveVideo'; bytes: Uint8Array /* WebM */; filename: string }
  /**
   * Sent by the webview once the HTML bytes are assembled (X2).
   * The host writes these bytes to the file chosen in the save dialog.
   */
  | {
      type: 'exportHtmlReady';
      /** Complete HTML file as UTF-8 bytes. */
      htmlBytes: Uint8Array;
    }
  /** Webview gained keyboard focus (item 1): host sets positronAtlas.webviewFocused context. */
  | { type: 'webviewFocused' }
  /** Webview lost keyboard focus (item 1): host clears positronAtlas.webviewFocused context. */
  | { type: 'webviewBlurred' }
  /** Notify host that nav preset changed (for positronAtlas.navPreset context key). */
  | { type: 'navPresetChanged'; preset: string }
  /**
   * Notify host that the active annotate sub-tool changed (item 7+8, B4).
   * Host sets positronAtlas.annotateTool context key so that [ / ] dispatch
   * brush size instead of rotation when the brush is active.
   * tool = null means the annotate sub-tool is inactive.
   */
  | { type: 'annotateToolChanged'; tool: 'brush' | 'shapes' | null }
  /** Notify host that animate values loaded/cleared (for positronAtlas.animating context key). */
  | { type: 'animatingChanged'; animating: boolean }
  /** User dismissed the first-run hint; host persists atlasHintShownV1 to globalState. */
  | { type: 'hintSeen' }
  /**
   * Reply from the webview after applying a Python API command (C3).
   * The command ID matches the one sent in the `apiCommand` ToWebview message.
   */
  | ApiReplyMsg
  /**
   * Sent by the webview when the selection changes so the host can
   * forward it to the Python kernel handle via comm (C3).
   * mask = null means the selection was cleared.
   */
  | {
      type: 'selectionChanged';
      /** Packed bits (uint8), one bit per kept row, LSB first. Null when cleared. */
      mask: Uint8Array | null;
      /** Number of kept/prepared rows (determines valid bit range). */
      nKept: number;
    }
  /** B3: apply base-job transforms to overlay variable; kernel calls prepare_overlay. */
  | { type: 'prepareOverlay'; layerId: string; variable: string }
  /** B3: place overlay rows via anchor index after prepareOverlay succeeds. */
  | { type: 'projectOverlay'; layerId: string; metric: 'euclidean' | 'cosine'; seed: number }
  /** B3: remove an overlay layer from the kernel job and the layer list. */
  | { type: 'removeOverlay'; layerId: string }
  /** B3: fetch row values from an overlay layer for hover/pin cards. */
  | { type: 'overlayRows'; layerId: string; seq: number; indices: number[]; columns?: number[] }
  /** B3/Item 9: request u16 category codes for a column (≤8 categories → symbol shapes). */
  | { type: 'symbolCodes'; column: number }
  /** B3: get column descriptions for an overlay variable (for search/filter). */
  | { type: 'describeOverlay'; layerId: string }
  /** B3: search an overlay layer's column for a substring query. */
  | { type: 'searchOverlay'; layerId: string; column: number; query: string; limit: number }
  /** B3: request float32 column values for a histogram filter on an overlay layer. */
  | { type: 'histValuesOverlay'; layerId: string; column: number };
