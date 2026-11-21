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
}

/** Persisted in the webview state so tabs can be restored after a reload. */
export interface PanelState {
  variable: string;
  sessionId: string;
  languageId: string;
  prepare?: PrepareOptions;
  umap?: UmapParams;
  colorColumn?: number | null;
  view?: { pointSize: number; opacity: number; mode: 'points' | 'density'; colormap: string; background?: string; images?: boolean; imageWidth?: number; imageInvert?: boolean };
  labels?: LabelOptions;
  /** Sidebar tab and the ids of collapsed sections. */
  ui?: { tab?: 'map' | 'explore' | 'annotate'; closed?: string[] };
}

export type ToWebview =
  | { type: 'init'; variable: string; sessionId: string; describe: DescribeResult; settings: Settings; state?: PanelState }
  | { type: 'status'; task: string; status: JobStatus }
  | { type: 'prepared'; result: PrepareResult; anchors: FileRef; anchorPos: FileRef }
  | { type: 'xyChunk'; file: FileRef; total: number }
  | { type: 'projected'; seconds: number; exact?: boolean }
  | { type: 'colors'; column: number; file: FileRef; meta: ColorMeta; length: number }
  | { type: 'labelCodes'; column: number; file: FileRef; meta: ColorMeta; length: number }
  | { type: 'row'; i: number; row: number; values: [string, string][]; image?: (number | null)[] }
  | { type: 'error'; message: string; detail?: string; fatal?: boolean }
  | { type: 'coordsAdded'; variable: string; columns: string[] }
  | { type: 'estimate'; seconds: number; rows: number };

export type ToHost =
  | { type: 'ready' }
  | { type: 'prepare'; options: PrepareOptions }
  | { type: 'estimate' }
  | { type: 'project'; anchorXY: string /* base64 little-endian float32 */; metric: 'euclidean' | 'cosine'; seed: number }
  | { type: 'exact'; params: UmapParams }
  | { type: 'colors'; column: number; forceCategorical?: boolean }
  | { type: 'labelCodes'; column: number; maxCategories: number }
  | { type: 'row'; i: number; imageColumns?: number[] }
  | { type: 'cancel' }
  | { type: 'addCoordinates'; anchorXY: string | null /* base64 float32 */; useProjection: boolean }
  | { type: 'reload' }
  | { type: 'savePng'; dataUrl: string }
  | { type: 'copyText'; text: string }
  | { type: 'state'; state: PanelState }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
