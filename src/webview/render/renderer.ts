import { Deck, OrbitView, type OrbitViewState } from '@deck.gl/core';
import { LineLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { CollisionFilterExtension, DataFilterExtension } from '@deck.gl/extensions';
import { buildLeaderLinesLayer } from '../atlas/leaderLines';
import { compositeOverlay } from './composite';
import { ensureFont } from '../fonts';
import type { AnnotationData, NavigationSettings, TitleOptions } from '../../shared/protocol';
import type { AroundLabel } from '../labels/around';
import { NavController } from './controller';

/** Minimal interface from Atlas that the renderer needs for PNG compositing. */
export interface OverlayState {
  titleOverlay: TitleOptions;
  annotations: Map<string, AnnotationData>;
  /** A11 around-the-map labels for export (optional). */
  aroundLabels?: AroundLabel[];
  leaderStyle?: 'straight' | 'curved' | 'wedge';
  leaderColor?: 'cluster' | 'grey';
  leaderWidth?: number;
  labelFontFamily?: string;
  /** A12 glow canvas for export (pre-rendered, optional). */
  glowCanvas?: HTMLCanvasElement | null;
}

export interface PointSet {
  id: string;
  /** Interleaved x,y (2D) or x,y,z (3D). */
  positions: Float32Array;
  /** RGBA per point. */
  colors: Uint8Array;
  length: number;
  /** Number of values per point: 2 (default) or 3 for 3D (T2). */
  positionStride?: 2 | 3;
  /** Per-point radius in pixels (A10). When omitted the uniform pointSize is used. */
  radii?: Float32Array;
  /**
   * Layer opacity multiplier (A2): 0–1, applied on top of the global style.opacity.
   * Default 1 (no change).
   */
  layerOpacity?: number;
  /**
   * Per-layer blending mode (A2): 'normal' (default) or 'additive'.
   * Overrides the global density/additive logic for this point set.
   */
  layerBlending?: 'normal' | 'additive';
  /** Id of the layer this point set belongs to (A2). Used by picking to identify the layer. */
  layerId?: string;
}

/** A text label on the map (world coordinates, size in pixels). */
export interface MapLabel {
  text: string;
  position: [number, number];
  size: number;
  color: [number, number, number, number];
  /** Higher wins when labels overlap (CollisionFilterExtension). */
  priority: number;
  /** Font weight for this label (100–900). When undefined, uses LabelStyle.fontWeight. */
  weight?: number;
  /** Badge background color (RGBA). When set, renders as a filled badge. */
  badge?: [number, number, number, number];
  /** Original group name used as the drag-offset key. */
  key?: string;
}

export interface LabelStyle {
  /** Outline (halo) color, usually the plot background, as RGBA. */
  outline: [number, number, number, number];
  fontFamily: string;
  /** Base font weight (100–900). Default 600. */
  fontWeight?: number;
  /** Halo/outline width multiplier passed to outlineWidth (0 = no halo). */
  haloWidth?: number;
  /** Line height multiplier. */
  lineHeight?: number;
  /** Wrap width in deck.gl em units (maxWidth). */
  maxWidth?: number;
  /**
   * B5 (Q13): When 'common', text scales with zoom (figure-like).
   * When 'pixels' (default), text stays readable at every zoom.
   */
  sizeUnits?: 'pixels' | 'common';
}

export interface RenderStyle {
  pointSize: number;
  opacity: number;
  mode: 'points' | 'density';
}

/** Per-point u16 category code, used by DataFilterExtension for legend toggles. */
export interface FilterAttribute {
  /** u16 category codes per point, same length as positions / 2. */
  codes: Uint16Array;
  /** Set of hidden category indices. */
  hidden: Set<number>;
  /**
   * Pre-computed filter values (1 = visible, 0 = hidden).
   * When present, used directly instead of re-deriving from codes + hidden.
   * Supports combined legend + histogram filters (A13).
   */
  precomputed?: Float32Array;
}

const ADDITIVE = {
  blend: true,
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false,
  depthCompare: 'always',
} as const;

const NORMAL = { depthWriteEnabled: false, depthCompare: 'always' } as const;

/** Height of the plot toolbar plus the search box, kept free when fitting the view. */
const FIT_TOP_PX = 76;

/**
 * Overlay descriptor for the sorted registry (A2).
 * Controls whether a named overlay bucket is visible in the deck.gl layer array and at what opacity.
 * Ids: 'base' (ScatterplotLayers), 'outlines' (PolygonLayer), 'labels' (TextLayers).
 * The hover/pin ring is not in this list — it is always rendered last (system layer).
 */
export interface OverlayDescriptor {
  id: string;
  visible: boolean;
  /** Opacity multiplier (0–1). */
  opacity: number;
}

/**
 * rotationX value used for the top-down 2D OrbitView (looking straight down the Z axis).
 * Empirically: orbitAxis='Z', rotationX=90 places the camera above the XY plane looking down.
 */
const ORBIT_2D_ROTATION_X = 90;

/** deck.gl scatter renderer with binary attributes and a controlled orbit view (2D and 3D). */
export class ScatterRenderer {
  private deck: Deck<OrbitView>;
  private sets: PointSet[] = [];
  private style: RenderStyle = { pointSize: 3, opacity: 0.8, mode: 'points' };
  private viewState: OrbitViewState = { target: [0, 0, 0], zoom: 0 };
  /** Current output dimensionality: 2 = top-down OrbitView (orthographic), 3 = OrbitView (T2/T3). */
  private dims: 2 | 3 = 2;
  private version = 0;
  private pointerListeners: ((p: { x: number; y: number; world: [number, number] } | null) => void)[] = [];
  private userMoved = false;
  labels: MapLabel[] = [];
  private outlines: [number, number][][] = [];
  /** Zoom level set by the last fit() call. Used for zoom-dependent fine-label visibility (A8). */
  fittedZoom: number = -Infinity;
  private outlineColor: [number, number, number] = [200, 200, 200];
  /** Per-outline RGBA colors (A6). Overrides outlineColor when set. */
  private outlineColors: [number, number, number, number][] | null = null;
  private labelStyle: LabelStyle = { outline: [30, 30, 30, 255], fontFamily: 'sans-serif' };
  /**
   * Sorted overlay descriptors (A2): control draw order, visibility and opacity for
   * the deck.gl overlay buckets.  Set by setOverlayDescriptors(); defaults give the
   * original hard-coded order (base → outlines → labels).
   */
  private overlayDescs: OverlayDescriptor[] = [
    { id: 'base', visible: true, opacity: 1 },
    { id: 'outlines', visible: true, opacity: 1 },
    { id: 'labels', visible: true, opacity: 1 },
  ];
  /** B5: current annotations for the leader-lines deck.gl layer. */
  private annotations: Map<string, AnnotationData> = new Map();
  private readonly collision = new CollisionFilterExtension();
  private readonly dataFilter = new DataFilterExtension({ filterSize: 1 });
  /** Prepared-row index of the hovered point (for the ring), or -1. */
  private hoveredIdx = -1;
  /** Prepared-row index of the pinned point (for the ring), or -1. */
  private pinnedIdx = -1;
  /** Shared all-ones filter values (no category hidden), grown as needed. */
  private ones = new Float32Array(0);

  // ---- A3 label drag state ----
  private draggingLabel: MapLabel | null = null;
  private dragStartScreen: [number, number] = [0, 0];
  private labelHovered = false;
  /** Set to true when a label drag with meaningful movement ends; consumed by onClick to suppress card pinning. */
  private suppressNextClick = false;
  private labelDragCallback: {
    onStart?: (label: MapLabel, screenPos: [number, number]) => void;
    onMove?: (label: MapLabel, screenDelta: [number, number]) => void;
    onEnd?: (label: MapLabel, screenDelta: [number, number]) => void;
    onRightClick?: (label: MapLabel, screenPos: [number, number]) => void;
  } = {};

  // ---- A8 view change callback ----
  private viewChangeCallback: ((zoom: number) => void) | null = null;

  // ---- Navigation settings (item 1) ---
  /** Custom pointer + wheel handler for preset-specific navigation. */
  private navController: NavController | null = null;
  /** Callback to get the current tool (for CAD left-drag routing). Set by setNavSettings. */
  private getTool: (() => 'pan' | 'lasso' | 'annotate') | null = null;

  private allVisible(n: number): Float32Array {
    if (this.ones.length < n) this.ones = new Float32Array(Math.max(n, this.ones.length * 2)).fill(1);
    return this.ones.subarray(0, n);
  }

  /** Per-point-set filter attributes (category codes + hidden set). */
  private filters: (FilterAttribute | null)[] = [];
  /** Per-point-set search match mask (1 = match, 0 = non-match).  Null per set means no search active. */
  private searchFilters: (Float32Array | null)[] = [];

  constructor(private readonly container: HTMLElement) {
    // 2D uses an OrbitView in orthographic top-down mode (rotationX=90, orbitAxis='Z').
    // This keeps deck.gl's own unproject/project correct through rotation, so hover, lasso,
    // labels and annotations need no extra inverse-rotation math (Q9 rationale).
    // With dragMode:'pan' the left button pans; right button (alternateMode) rotates the orbit
    // (rotationOrbit only, since minRotationX=maxRotationX=90 locks the tilt).
    const initState: OrbitViewState = {
      target: [0, 0, 0],
      zoom: 0,
      rotationX: ORBIT_2D_ROTATION_X,
      rotationOrbit: 0,
      minRotationX: ORBIT_2D_ROTATION_X,
      maxRotationX: ORBIT_2D_ROTATION_X,
    };
    this.viewState = initState;
    this.deck = new Deck({
      parent: container,
      views: new OrbitView({ id: 'orbit', orbitAxis: 'Z', orthographic: true }),
      viewState: this.viewState as any,
      controller: {
        scrollZoom: { speed: 0.01, smooth: false },
        doubleClickZoom: true,
        dragMode: 'pan',
      } as any,
      onViewStateChange: ({ viewState, interactionState }: any) => {
        this.viewState = viewState;
        if (interactionState?.isDragging || interactionState?.isZooming || interactionState?.isPanning) {
          this.userMoved = true;
        }
        this.deck.setProps({ viewState });
        const zoom = typeof viewState.zoom === 'number' ? viewState.zoom : 0;
        this.viewChangeCallback?.(zoom);
        return viewState;
      },
      onHover: (info: any) => {
        const isLabelHit = !!(info?.layer?.id?.startsWith('labels') && info.object);
        this.labelHovered = isLabelHit;
        if (!info || info.x < 0 || !info.coordinate) {
          this.pointerListeners.forEach((l) => l(null));
          return;
        }
        // In 3D mode, world is a 3D coord from OrbitView; use the screen (x, y) for picking.
        // The pointer listener receives a 2-element world tuple (x, y) for compatibility.
        const world: [number, number] = this.dims === 3
          ? [info.coordinate[0] ?? 0, info.coordinate[1] ?? 0]
          : [info.coordinate[0], info.coordinate[1]];
        this.pointerListeners.forEach((l) => l({ x: info.x, y: info.y, world }));
      },
      // Deck-level drag: intercept label drags before the controller pans.
      onDragStart: (info: any) => {
        if (info?.layer?.id?.startsWith('labels') && info.object) {
          this.draggingLabel = info.object as MapLabel;
          this.dragStartScreen = [info.x, info.y];
          this.labelDragCallback.onStart?.(this.draggingLabel, [info.x, info.y]);
          return true; // prevent map pan
        }
      },
      onDrag: (info: any) => {
        if (this.draggingLabel) {
          const delta: [number, number] = [info.x - this.dragStartScreen[0], info.y - this.dragStartScreen[1]];
          this.labelDragCallback.onMove?.(this.draggingLabel, delta);
        }
      },
      onDragEnd: (info: any) => {
        if (this.draggingLabel) {
          const delta: [number, number] = [info.x - this.dragStartScreen[0], info.y - this.dragStartScreen[1]];
          // If the drag moved more than 3 px, suppress the subsequent click so it doesn't pin a hover card.
          if (Math.hypot(delta[0], delta[1]) > 3) {
            this.suppressNextClick = true;
          }
          this.labelDragCallback.onEnd?.(this.draggingLabel, delta);
          this.draggingLabel = null;
        }
      },
      onClick: (info: any, event: any) => {
        if (info?.layer?.id?.startsWith('labels') && info.object && (event?.srcEvent?.button === 2 || event?.rightButton)) {
          this.labelDragCallback.onRightClick?.(info.object as MapLabel, [info.x, info.y]);
        }
      },
      getCursor: ({ isDragging }: any) => {
        if (this.draggingLabel) return 'grabbing';
        if (this.labelHovered) return 'grab';
        return isDragging ? 'grabbing' : 'crosshair';
      },
      useDevicePixels: true,
      layers: [],
    } as any);

    // Also listen for context-menu (right-click) events on the canvas.
    container.addEventListener('contextmenu', (e) => {
      const canvas = container.querySelector('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const info = (this.deck as any).pickObject?.({ x, y, radius: 4 });
      if (info?.layer?.id?.startsWith('labels') && info.object) {
        e.preventDefault();
        this.labelDragCallback.onRightClick?.(info.object as MapLabel, [x, y]);
      }
    });
  }

  onPointer(cb: (p: { x: number; y: number; world: [number, number] } | null) => void): void {
    this.pointerListeners.push(cb);
  }

  /** Register label drag/right-click callbacks (A3). */
  onLabelDrag(cb: {
    onStart?: (label: MapLabel, screenPos: [number, number]) => void;
    onMove?: (label: MapLabel, screenDelta: [number, number]) => void;
    onEnd?: (label: MapLabel, screenDelta: [number, number]) => void;
    onRightClick?: (label: MapLabel, screenPos: [number, number]) => void;
  }): void {
    this.labelDragCallback = cb;
  }

  /** Register a callback fired when the zoom level changes (A8). */
  onViewChange(cb: (zoom: number) => void): void {
    this.viewChangeCallback = cb;
  }

  /**
   * Returns true (and clears the flag) when a label drag with meaningful movement just ended.
   * Call from onClick to suppress card pinning after a label drag.
   */
  consumeSuppressClick(): boolean {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return true;
    }
    return false;
  }

  /** World coordinates of a point in CSS pixels relative to the plot. */
  unproject(x: number, y: number): [number, number] {
    const vp = (this.deck as any).getViewports?.()[0];
    if (vp) {
      const [wx, wy] = vp.unproject([x, y]);
      return [wx, wy];
    }
    // Fallback: the orthographic view centered on target (y up, flipY false).
    const scale = Math.pow(2, this.viewState.zoom as number);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const t = this.viewState.target as number[];
    return [t[0] + (x - w / 2) / scale, t[1] - (y - h / 2) / scale];
  }

  /** World units per screen pixel at the current zoom. */
  worldPerPixel(): number {
    return Math.pow(2, -(this.viewState.zoom as number));
  }

  /**
   * Convert a screen-pixel drag delta to a world-space delta (B5).
   * Uses the viewport's unproject so the result is correct under 2D rotation and in 3D.
   * x0, y0 are the drag-start CSS pixel coordinates (relative to the canvas).
   * dx, dy are the screen-pixel displacement.
   */
  screenDeltaToWorld(x0: number, y0: number, dx: number, dy: number): [number, number] {
    const w0 = this.unproject(x0, y0);
    const w1 = this.unproject(x0 + dx, y0 + dy);
    return [w1[0] - w0[0], w1[1] - w0[1]];
  }

  /** Current zoom level. */
  currentZoom(): number {
    return typeof this.viewState.zoom === 'number' ? this.viewState.zoom : 0;
  }

  /** Project world coordinates to CSS-pixel screen coordinates (inverse of unproject).
   *  Returns null when the viewport is not ready.
   *  wz is optional; in 2D it is ignored; in 3D it is used for the perspective projection. */
  projectWorld(wx: number, wy: number, wz = 0): [number, number] | null {
    const vp = (this.deck as any).getViewports?.()[0];
    if (vp) {
      const coords: [number, number] | [number, number, number] = this.dims === 3 ? [wx, wy, wz] : [wx, wy];
      const [sx, sy] = vp.project(coords);
      return [sx, sy];
    }
    // Fallback: orthographic view centered on target.
    const scale = Math.pow(2, this.viewState.zoom as number);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const t = this.viewState.target as number[];
    const sx = (wx - t[0]) * scale + w / 2;
    const sy = -(wy - t[1]) * scale + h / 2;
    return [sx, sy];
  }

  /**
   * Project a 3D world position and return the CSS depth (normalized z in [0,1]).
   * Values > 0.5 are behind the view center — used for depth fade.
   * Returns 0 when not in 3D mode or viewport not ready.
   */
  projectWorldDepth(wx: number, wy: number, wz = 0): number {
    if (this.dims !== 3) return 0;
    const vp = (this.deck as any).getViewports?.()[0];
    if (!vp) return 0;
    // vp.project returns [sx, sy, depth] in deck.gl
    const proj = vp.project([wx, wy, wz]);
    return proj[2] ?? 0;
  }

  /** B5: return the canvas dimensions in CSS pixels for off-screen clamping. */
  get canvasSize(): { width: number; height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  setStyle(style: Partial<RenderStyle>): void {
    this.style = { ...this.style, ...style };
    this.render();
  }

  setPointSets(sets: PointSet[], filters?: (FilterAttribute | null)[]): void {
    this.sets = sets;
    this.filters = filters ?? sets.map(() => null);
    // Reset search filters to match new set count (clear stale entries).
    this.searchFilters = sets.map((_, i) => this.searchFilters[i] ?? null);
    this.version++;
    this.render();
  }

  /**
   * Set per-point-set search match masks (1.0 = match, 0.0 = non-match).
   * Pass null to clear the search highlight.
   */
  setSearch(sf: (Float32Array | null)[] | null): void {
    this.searchFilters = sf ?? [];
    this.render();
  }

  /** Set the hovered/pinned point indices for the hover ring (A5). */
  setHoverRing(hoveredIdx: number, pinnedIdx: number): void {
    if (this.hoveredIdx === hoveredIdx && this.pinnedIdx === pinnedIdx) return;
    this.hoveredIdx = hoveredIdx;
    this.pinnedIdx = pinnedIdx;
    this.render();
  }

  /**
   * Update the sorted overlay descriptors (A2).
   * Called whenever atlas.layers changes (via atlas.updateLayer / atlas.reorderLayer).
   * Only 'base', 'outlines' and 'labels' ids are acted on; unknown ids are ignored.
   */
  setOverlayDescriptors(descs: OverlayDescriptor[]): void {
    this.overlayDescs = descs;
    this.render();
  }

  /** B5: update annotation data used for the leader-lines deck.gl layer. */
  setAnnotations(annotations: Map<string, AnnotationData>): void {
    this.annotations = annotations;
    this.render();
  }

  /** Replace the text labels (an empty list removes them). */
  setLabels(labels: MapLabel[], style?: Partial<LabelStyle>): void {
    this.labels = labels;
    if (style) {
      this.labelStyle = { ...this.labelStyle, ...style };
    }
    this.render();
  }

  /** Replace the cluster outlines (rings in world coordinates; an empty list removes them).
   *  Optionally provide per-outline RGBA colors (A6): one entry per ring. */
  setOutlines(
    rings: [number, number][][],
    color?: [number, number, number],
    perColors?: [number, number, number, number][],
  ): void {
    if (rings.length === 0 && this.outlines.length === 0) {
      return;
    }
    this.outlines = rings;
    if (color) {
      this.outlineColor = color;
    }
    this.outlineColors = perColors ?? null;
    this.render();
  }

  /** Fit the view to the given bounds unless the user has panned/zoomed (force overrides). */
  /**
   * @param b        World-space bounding box [minX, minY, maxX, maxY].
   * @param force    When true, reset userMoved and re-fit even after manual navigation.
   * @param padRight Reserve this many pixels on the right for the legend.
   * @param padExtra Extra fractional margin on all sides (0–1).  Pass 0.2 to leave 20 % of
   *                 the available width/height clear of the data cloud on each side, which
   *                 makes room for around-the-map label rings (A11).
   */
  fit(b: [number, number, number, number], force = false, padRight = 0, padExtra = 0): void {
    if (this.userMoved && !force) {
      return;
    }
    if (force) {
      this.userMoved = false;
    }
    const fullW = this.container.clientWidth || 800;
    const pad = fullW - padRight > 200 ? padRight : 0;
    const w = fullW - pad;
    const fullH = this.container.clientHeight || 600;
    // Keep the band under the plot toolbar and search box (top left) free of data.
    const top = fullH > 300 ? FIT_TOP_PX : 0;
    const h = fullH - top;
    const dx = Math.max(b[2] - b[0], 1e-6);
    const dy = Math.max(b[3] - b[1], 1e-6);
    // A rotated 2D map needs room for the rotated bounding box.
    const vs = this.viewState as OrbitViewState;
    const theta = this.dims === 2 ? ((vs.rotationOrbit ?? 0) * Math.PI) / 180 : 0;
    const c = Math.abs(Math.cos(theta));
    const sn = Math.abs(Math.sin(theta));
    const rw = dx * c + dy * sn;
    const rh = dx * sn + dy * c;
    // padExtra shrinks the effective viewport so the point cloud occupies only the
    // inner (1 - 2·padExtra) fraction, leaving room around it for label rings.
    const scale = Math.min(w / rw, h / rh) * 0.9 * (1 - 2 * padExtra);
    const zoom = Math.log2(scale);
    // Shift the target so the data sits left of the legend and below the toolbar:
    // the data centre must appear (-pad/2, +top/2) screen pixels from the screen centre.
    const [ox, oy] = this.worldPerScreenPixel(-pad / 2, top / 2, scale);
    const cx = (b[0] + b[2]) / 2 - ox;
    const cy = (b[1] + b[3]) / 2 - oy;
    this.viewState = { ...this.view2DOrientation(), target: [cx, cy, 0], zoom };
    this.fittedZoom = zoom; // A8: record overview zoom for fine-label threshold
    this.deck.setProps({ viewState: this.viewState as any });
  }

  /** The fixed top-down tilt and the current rotation of the 2D map (kept by every fit). */
  private view2DOrientation(): Partial<OrbitViewState> {
    if (this.dims !== 2) return {};
    const vs = this.viewState as OrbitViewState;
    return {
      rotationX: ORBIT_2D_ROTATION_X,
      rotationOrbit: vs.rotationOrbit ?? 0,
      minRotationX: ORBIT_2D_ROTATION_X,
      maxRotationX: ORBIT_2D_ROTATION_X,
    };
  }

  /**
   * The world-space vector that a screen offset of (sx, sy) pixels (y down) covers at
   * `scale` pixels per world unit, in the current 2D orientation. Uses the live viewport
   * when there is one, so it follows deck.gl's own rotation convention.
   */
  private worldPerScreenPixel(sx: number, sy: number, scale: number): [number, number] {
    const vp = (this.deck as any)?.getViewports?.()[0];
    if (vp && this.dims === 2) {
      const vpScale = Math.pow(2, vp.zoom);
      const o = vp.unproject([vp.width / 2, vp.height / 2]);
      const ux = vp.unproject([vp.width / 2 + 1, vp.height / 2]);
      const uy = vp.unproject([vp.width / 2, vp.height / 2 + 1]);
      const k = vpScale / scale;
      return [
        (sx * (ux[0] - o[0]) + sy * (uy[0] - o[0])) * k,
        (sx * (ux[1] - o[1]) + sy * (uy[1] - o[1])) * k,
      ];
    }
    // No viewport yet: north-up (screen y points down, world y up).
    return [sx / scale, -sy / scale];
  }

  private render(): void {
    const { pointSize, opacity, mode } = this.style;
    const density = mode === 'density' && this.dims === 2; // density not supported in 3D
    const is3D = this.dims === 3;
    // In 3D mode use depth testing so closer points occlude farther ones.
    const NORMAL_3D = { depthWriteEnabled: true, depthCompare: 'less-equal' } as const;
    const searchActive = this.searchFilters.some((sf) => sf !== null);
    const layers: (ScatterplotLayer | PolygonLayer<[number, number][]> | TextLayer<MapLabel>)[] = [];

    // --- build helpers ---

    /** Push ScatterplotLayers for the base point-set bucket. */
    const pushBaseLayers = (): void => {
      for (let si = 0; si < this.sets.length; si++) {
        const s = this.sets[si];
        if (s.length === 0) continue;
        const nd = s.positionStride ?? 2;
        const filter = this.filters[si] ?? null;
        // A precomputed histogram filter must also be applied even when hidden.size === 0.
        const hasFilter = filter !== null && (filter.hidden.size > 0 || !!filter.precomputed);
        // Always attach the DataFilterExtension and a filter value per point (1 = visible,
        // 0 = hidden; all ones without a filter). Adding or removing a layer extension after
        // the layer exists does not rebuild its shaders, which hid every point.
        const legendValues = hasFilter ? buildFilterValues(filter) : this.allVisible(s.length);
        const sf = this.searchFilters[si] ?? null;
        // A2: per-layer opacity multiplier and blending override.
        const layerOpacity = s.layerOpacity ?? 1;
        const effectiveOpacity = opacity * layerOpacity;
        const layerBlending = s.layerBlending;
        const setParams = layerBlending === 'additive'
          ? ADDITIVE
          : (is3D ? NORMAL_3D : (density ? ADDITIVE : NORMAL));

        // Build a data attributes object to support optional per-point radii (A10).
        const makeAttrs = (filterValue: Float32Array): Record<string, any> => {
          const attrs: Record<string, any> = {
            getPosition: { value: s.positions, size: nd },
            getFillColor: { value: s.colors, size: 4, normalized: true },
            getFilterValue: { value: filterValue, size: 1 },
          };
          if (s.radii) attrs['getRadius'] = { value: s.radii, size: 1 };
          return attrs;
        };

        if (searchActive && sf !== null) {
          // Two-pass: faded base layer for all legend-visible points, bright highlight for matches.
          // The highlight pass only shows points that BOTH match the search AND are legend-visible.
          const searchAndVisible = new Float32Array(sf.length);
          for (let i = 0; i < sf.length; i++) {
            searchAndVisible[i] = Math.min(sf[i], legendValues[i]);
          }
          // Base pass: all legend-visible points at reduced opacity.
          layers.push(new ScatterplotLayer({
            id: `points-${s.id}-base`,
            data: { length: s.length, attributes: makeAttrs(legendValues) } as any,
            radiusUnits: 'pixels',
            // In 3D, draw points as camera-facing dots (flat discs look like dashes when tilted).
            billboard: is3D,
            getRadius: s.radii ? 1 : pointSize / 2,
            radiusMinPixels: 0.5,
            stroked: false,
            filled: true,
            antialiasing: !density,
            opacity: density ? Math.max(0.02, effectiveOpacity * 0.03) : effectiveOpacity * 0.18,
            pickable: false,
            parameters: setParams as any,
            updateTriggers: { getPosition: this.version, getFillColor: this.version, getFilterValue: this.version },
            extensions: [this.dataFilter],
            filterRange: [0.5, 1.5] as [number, number],
          }));
          // Highlight pass: only matching & legend-visible points at full opacity.
          layers.push(new ScatterplotLayer({
            id: `points-${s.id}-highlight`,
            data: { length: s.length, attributes: makeAttrs(searchAndVisible) } as any,
            radiusUnits: 'pixels',
            // In 3D, draw points as camera-facing dots (flat discs look like dashes when tilted).
            billboard: is3D,
            getRadius: s.radii ? 1 : pointSize / 2,
            radiusMinPixels: 0.5,
            stroked: false,
            filled: true,
            antialiasing: !density,
            opacity: density ? Math.max(0.02, effectiveOpacity * 0.15) : effectiveOpacity,
            pickable: false,
            parameters: setParams as any,
            updateTriggers: { getPosition: this.version, getFillColor: this.version, getFilterValue: this.version },
            extensions: [this.dataFilter],
            filterRange: [0.5, 1.5] as [number, number],
          }));
        } else {
          // No search: single layer with combined legend+histogram filter.
          layers.push(new ScatterplotLayer({
            id: `points-${s.id}`,
            data: { length: s.length, attributes: makeAttrs(legendValues) } as any,
            radiusUnits: 'pixels',
            // In 3D, draw points as camera-facing dots (flat discs look like dashes when tilted).
            billboard: is3D,
            getRadius: s.radii ? 1 : pointSize / 2,
            radiusMinPixels: 0.5,
            stroked: false,
            filled: true,
            antialiasing: !density,
            opacity: density ? Math.max(0.02, effectiveOpacity * 0.15) : effectiveOpacity,
            pickable: false,
            parameters: setParams as any,
            updateTriggers: { getPosition: this.version, getFillColor: this.version, getFilterValue: this.version },
            // filterRange [0.5, 1.5] shows values == 1 (visible) and hides values == 0 (hidden).
            extensions: [this.dataFilter],
            filterRange: [0.5, 1.5] as [number, number],
          }));
        }
      }
    };

    /** Push the PolygonLayer for cluster outlines at the given opacity. */
    const pushOutlinesLayer = (layerOpacity: number): void => {
      if (!this.outlines.length) return;
      const [r, g, b] = this.outlineColor;
      const perColors = this.outlineColors;
      layers.push(
        new PolygonLayer<[number, number][]>({
          id: 'outlines',
          data: this.outlines,
          getPolygon: (d: [number, number][]) => d,
          stroked: true,
          filled: true,
          opacity: layerOpacity,
          getFillColor: perColors
            ? (_d: [number, number][], { index }: any) => { const c = perColors[index] ?? [r, g, b, 14]; return [c[0], c[1], c[2], 14] as [number,number,number,number]; }
            : [r, g, b, 14],
          getLineColor: perColors
            ? (_d: [number, number][], { index }: any) => { const c = perColors[index] ?? [r, g, b, 150]; return [c[0], c[1], c[2], 150] as [number,number,number,number]; }
            : [r, g, b, 150],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.25,
          pickable: false,
          parameters: NORMAL as any,
          updateTriggers: { getFillColor: this.version, getLineColor: this.version },
        } as any),
      );
    };

    /** Push TextLayers for cluster/column labels at the given opacity. */
    const pushLabelsLayers = (layerOpacity: number): void => {
      if (!this.labels.length) return;
      const { outline, fontFamily, fontWeight: baseFontWeight = 600, haloWidth: haloW = 10, lineHeight: lh = 0.95, maxWidth: mw = 9 } = this.labelStyle;
      // Split into badge labels and normal labels; group normal by weight bucket for per-label weight variation.
      const badgeLabels = this.labels.filter((l) => l.badge);
      const normalLabels = this.labels.filter((l) => !l.badge);
      // Collect unique weights among normal labels; fall back to baseFontWeight.
      const weightSet = new Set(normalLabels.map((l) => l.weight ?? baseFontWeight));
      const weights = Array.from(weightSet).sort((a, b) => a - b);

      const { sizeUnits: labelSizeUnits = 'pixels' } = this.labelStyle;
      const commonProps = {
        sizeUnits: labelSizeUnits,
        fontFamily,
        characterSet: 'auto',
        fontSettings: { sdf: true, fontSize: 64, buffer: 16, radius: 16 },
        outlineWidth: haloW,
        outlineColor: outline,
        lineHeight: lh,
        maxWidth: mw,
        wordBreak: 'break-word',
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        pickable: !is3D,  // disable drag/context menu in 3D (T5); billboard labels don't support drag
        extensions: [this.collision],
        collisionEnabled: true,
        getCollisionPriority: (d: MapLabel) => d.priority,
        collisionTestProps: { sizeScale: 1.4 },
        parameters: NORMAL as any,
        opacity: layerOpacity,
        // T3: billboard=true makes labels face the camera in 3D; collision still works in screen space.
        ...(is3D ? { billboard: true } : {}),
      } as const;

      // Normal labels – one TextLayer per distinct weight bucket.
      for (const w of weights) {
        const bucket = normalLabels.filter((l) => (l.weight ?? baseFontWeight) === w);
        if (!bucket.length) continue;
        layers.push(
          new TextLayer<MapLabel>({
            id: `labels-w${w}`,
            data: bucket,
            getText: (d: MapLabel) => d.text,
            getPosition: (d: MapLabel) => d.position,
            getSize: (d: MapLabel) => d.size,
            getColor: (d: MapLabel) => d.color,
            fontWeight: w,
            ...commonProps,
          } as any),
        );
      }

      // Badge labels (A9): filled background, white text, slightly higher collision priority.
      if (badgeLabels.length) {
        layers.push(
          new TextLayer<MapLabel>({
            id: 'labels-badges',
            data: badgeLabels,
            getText: (d: MapLabel) => d.text,
            getPosition: (d: MapLabel) => d.position,
            getSize: (d: MapLabel) => d.size,
            getColor: [255, 255, 255, 255],
            fontWeight: 800,
            background: true,
            getBackgroundColor: (d: MapLabel) => d.badge ?? [0, 0, 0, 200],
            backgroundPadding: [4, 2, 4, 2],
            getBorderColor: [255, 255, 255, 60],
            getBorderWidth: 1,
            ...commonProps,
            outlineWidth: 0, // badges have solid background; no halo needed
          } as any),
        );
      }
    };

    // --- build the deck.gl layer array in descriptor order ---
    // The overlay descriptors control draw order, visibility and opacity for the named
    // buckets.  Any id not recognised is silently skipped.  The hover/pin ring is always
    // appended last (system layer, non-reorderable, always visible on top).
    for (const desc of this.overlayDescs) {
      if (!desc.visible) continue;
      if (desc.id === 'base') {
        pushBaseLayers();
      } else if (desc.id === 'outlines') {
        pushOutlinesLayer(desc.opacity);
      } else if (desc.id === 'labels') {
        pushLabelsLayers(desc.opacity);
      } else if (desc.id === 'leader-lines' && this.annotations.size > 0) {
        // B5: leader lines as deck.gl LineLayer so they orbit correctly in 3D.
        const lineWidth = 1.5;
        layers.push(buildLeaderLinesLayer(this.annotations, is3D, desc.opacity, lineWidth) as any);
      }
      // 'glow', 'annotations', 'around-labels' are HTML overlays – not deck.gl layers.
    }

    // --- hover / pin ring (system layer, always last) ---
    const ringIndices: { idx: number; pinned: boolean }[] = [];
    if (this.hoveredIdx >= 0) ringIndices.push({ idx: this.hoveredIdx, pinned: false });
    if (this.pinnedIdx >= 0 && this.pinnedIdx !== this.hoveredIdx) ringIndices.push({ idx: this.pinnedIdx, pinned: true });
    for (const { idx, pinned } of ringIndices) {
      // Find the point position in the last set that covers this index.
      const pos = this.findPointPosition(idx);
      if (pos) {
        layers.push(
          new ScatterplotLayer({
            id: `ring-${pinned ? 'pin' : 'hover'}-${idx}`,
            data: [pos],
            getPosition: (d: number[]) => d as [number, number] | [number, number, number],
            radiusUnits: 'pixels',
            // In 3D, draw points as camera-facing dots (flat discs look like dashes when tilted).
            billboard: is3D,
            getRadius: (this.style.pointSize / 2) + 3,
            radiusMinPixels: 4,
            stroked: true,
            filled: false,
            getLineColor: pinned ? [255, 200, 50, 220] : [255, 255, 255, 180],
            lineWidthUnits: 'pixels',
            getLineWidth: pinned ? 2.5 : 1.5,
            pickable: false,
            parameters: NORMAL as any,
            updateTriggers: { getPosition: idx },
          } as any),
        );
      }
    }

    this.deck.setProps({ layers });
  }

  /**
   * Switch between 2D (top-down orthographic OrbitView) and 3D (perspective OrbitView) (T2/T3).
   * Resets the view state and rebuilds the Deck instance properties.
   *
   * Both modes use OrbitView, so we only change the view props and controller options.
   * In 2D: orthographic=true, rotationX locked to ORBIT_2D_ROTATION_X, dragMode:'pan'
   *         → left drag pans, right drag rotates the 2D map (rotationOrbit only).
   * In 3D: perspective, standard 20° tilt, dragMode:'rotate'
   *         → left drag orbits, Shift-drag/right-drag pans.
   */
  setDims(dims: 2 | 3): void {
    if (this.dims === dims) return;
    this.dims = dims;
    this.userMoved = false;
    if (dims === 3) {
      const orbitState: OrbitViewState = {
        target: [0, 0, 0],
        zoom: 0,
        rotationX: 20,
        rotationOrbit: 0,
      };
      this.viewState = orbitState;
      this.deck.setProps({
        views: new OrbitView({ id: 'orbit', orbitAxis: 'Z' }),
        viewState: orbitState as any,
        // Drag rotates; Shift-drag/right-drag pans; scroll zooms.
        controller: { scrollZoom: { speed: 0.01, smooth: false }, doubleClickZoom: false, dragMode: 'rotate' } as any,
      });
    } else {
      const orthoState: OrbitViewState = {
        target: [0, 0, 0],
        zoom: 0,
        rotationX: ORBIT_2D_ROTATION_X,
        rotationOrbit: 0,
        minRotationX: ORBIT_2D_ROTATION_X,
        maxRotationX: ORBIT_2D_ROTATION_X,
      };
      this.viewState = orthoState;
      this.deck.setProps({
        views: new OrbitView({ id: 'orbit', orbitAxis: 'Z', orthographic: true }),
        viewState: orthoState as any,
        controller: {
          scrollZoom: { speed: 0.01, smooth: false },
          doubleClickZoom: true,
          dragMode: 'pan',
        } as any,
      });
    }
    this.version++;
    this.render();
  }

  /**
   * Fit the 3D view to [minX, minY, minZ, maxX, maxY, maxZ] bounds.
   * Sets the target to the centroid and zoom to show all points.
   */
  fit3D(b: [number, number, number, number, number, number], force = false): void {
    if (this.userMoved && !force) return;
    if (force) this.userMoved = false;
    const cx = (b[0] + b[3]) / 2;
    const cy = (b[1] + b[4]) / 2;
    const cz = (b[2] + b[5]) / 2;
    const dx = Math.max(b[3] - b[0], 1e-6);
    const dy = Math.max(b[4] - b[1], 1e-6);
    const dz = Math.max(b[5] - b[2], 1e-6);
    const size = Math.max(dx, dy, dz);
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const zoom = Math.log2(Math.min(w, h) * 0.75 / size);
    const orbitState: OrbitViewState = {
      target: [cx, cy, cz],
      zoom,
      rotationX: 20,
      rotationOrbit: 0,
    };
    this.viewState = orbitState;
    this.deck.setProps({ viewState: orbitState as any });
  }

  /**
   * Project all 3D points to screen space via the current OrbitViewport.
   * Returns a flat Float32Array of [sx0, sy0, sx1, sy1, ...], or null when the viewport is not ready.
   */
  projectAll3D(xyz: Float32Array, n: number): Float32Array | null {
    const vp = (this.deck as any).getViewports?.()[0];
    if (!vp) return null;
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const proj = vp.project([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]);
      out[2 * i] = proj[0];
      out[2 * i + 1] = proj[1];
    }
    return out;
  }

  /**
   * Rotate the orbit view by `degrees` around the orbit axis (Z).
   * Used by auto-rotate animation (T3).
   */
  rotateOrbit(degrees: number): void {
    if (this.dims !== 3) return;
    const vs = this.viewState as OrbitViewState;
    const next: OrbitViewState = {
      ...vs,
      rotationOrbit: ((vs.rotationOrbit ?? 0) + degrees) % 360,
    };
    this.viewState = next;
    this.deck.setProps({ viewState: next as any });
  }

  /**
   * Reset the 3D camera to the initial position (T3).
   */
  resetCamera3D(): void {
    if (this.dims !== 3) return;
    this.userMoved = false;
    const vs = this.viewState as OrbitViewState;
    const next: OrbitViewState = { ...vs, rotationX: 20, rotationOrbit: 0 };
    this.viewState = next;
    this.deck.setProps({ viewState: next as any });
  }

  // ---- 2D rotation (item 14) ---------------------------------------------------

  /**
   * Set the 2D map rotation angle (degrees, clockwise positive).
   * Only active in 2D mode; no-op in 3D.
   */
  setRotation2D(angleDeg: number): void {
    if (this.dims !== 2) return;
    const vs = this.viewState as OrbitViewState;
    const next: OrbitViewState = {
      ...vs,
      rotationOrbit: angleDeg % 360,
      minRotationX: ORBIT_2D_ROTATION_X,
      maxRotationX: ORBIT_2D_ROTATION_X,
    };
    this.viewState = next;
    this.deck.setProps({ viewState: next as any });
  }

  /**
   * Adjust the 2D map rotation by a delta (degrees, positive = clockwise).
   * Only active in 2D mode.
   */
  adjustRotation2D(deltaDeg: number): void {
    if (this.dims !== 2) return;
    const current = (this.viewState as OrbitViewState).rotationOrbit ?? 0;
    this.setRotation2D(current + deltaDeg);
  }

  /**
   * Return the current 2D rotation angle in degrees (0 = north-up).
   * Returns 0 in 3D mode.
   */
  getRotation2D(): number {
    if (this.dims !== 2) return 0;
    return (this.viewState as OrbitViewState).rotationOrbit ?? 0;
  }

  // ---- Keyboard pan / zoom helpers (used by InputDispatcher) --------------------

  /**
   * Pan the view by a fraction of the viewport size (positive x = right, positive y = down).
   * Works in both 2D and 3D.
   */
  panByFraction(fracX: number, fracY: number): void {
    const vp = (this.deck as any).getViewports?.()[0];
    const vs = this.viewState as OrbitViewState;
    if (vp) {
      const cx = this.container.clientWidth / 2;
      const cy = this.container.clientHeight / 2;
      const dx = fracX * this.container.clientWidth;
      const dy = fracY * this.container.clientHeight;
      // Unproject center and center+delta to get world-space delta.
      const c = vp.unproject([cx, cy]);
      const p = vp.unproject([cx + dx, cy + dy]);
      const target = vs.target as number[];
      const next: OrbitViewState = {
        ...vs,
        target: [
          target[0] + (c[0] - p[0]),
          target[1] + (c[1] - p[1]),
          target[2] ?? 0,
        ] as [number, number, number],
      };
      this.viewState = next;
      this.deck.setProps({ viewState: next as any });
    } else {
      // Fallback: use zoom to compute world units.
      const scale = Math.pow(2, vs.zoom as number);
      const target = vs.target as number[];
      const dx = (fracX * this.container.clientWidth) / scale;
      const dy = (fracY * this.container.clientHeight) / scale;
      const next: OrbitViewState = {
        ...vs,
        target: [target[0] + dx, target[1] + dy, target[2] ?? 0] as [number, number, number],
      };
      this.viewState = next;
      this.deck.setProps({ viewState: next as any });
    }
  }

  /**
   * Adjust the zoom level by `delta` deck.gl zoom units (positive = zoom in).
   */
  adjustZoom(delta: number): void {
    const vs = this.viewState as OrbitViewState;
    const next: OrbitViewState = {
      ...vs,
      zoom: (vs.zoom as number) + delta,
    };
    this.viewState = next;
    this.deck.setProps({ viewState: next as any });
  }

  /**
   * Set a camera preset: top (looking down Z), front (facing Y), or side (facing X).
   */
  setCameraPreset(preset: 'top' | 'front' | 'side'): void {
    if (this.dims !== 3) return;
    const vs = this.viewState as OrbitViewState;
    const angles = { top: { rotationX: 90, rotationOrbit: 0 }, front: { rotationX: 0, rotationOrbit: 0 }, side: { rotationX: 0, rotationOrbit: 90 } };
    const next: OrbitViewState = { ...vs, ...angles[preset] };
    this.viewState = next;
    this.userMoved = true;
    this.deck.setProps({ viewState: next as any });
  }

  /**
   * Apply navigation preset and option settings to the deck.gl controller (item 1).
   *
   * Preset controls the primary drag button behavior per 2D/3D mode:
   *   dataMap/molecular  2D: left=pan, right=rotate  3D: left=orbit, right/shift=pan
   *   cad                2D: left=pan (middle=pan via emulateMiddleButton)  3D: left=orbit
   *   design             2D: left=lasso (tool is set at the Atlas level), drag pan via Space
   *
   * invertZoom and scrollGesture are applied via a non-passive wheel interceptor installed
   * on the deck.gl canvas.  When both are default (zoom, not inverted) the interceptor is
   * removed so deck.gl handles the wheel natively.
   */
  setNavSettings(settings: NavigationSettings, dims: 2 | 3, getTool?: () => 'pan' | 'lasso' | 'annotate'): void {
    if (getTool) this.getTool = getTool;
    // ── deck.gl controller props ──────────────────────────────────────────────
    // 2D: left-drag pans (dragMode:'pan'), right-drag rotates via alternateMode.
    // 3D: left-drag orbits (dragMode:'rotate'), right-drag pans via alternateMode.
    // scrollZoom is disabled when scrollGesture=pan (NavController handles the wheel).
    const dragMode: 'pan' | 'rotate' = dims === 3 ? 'rotate' : 'pan';
    this.deck.setProps({
      controller: {
        scrollZoom: settings.scrollGesture === 'pan'
          ? false
          : { speed: 0.01, smooth: false },
        doubleClickZoom: dims === 2,
        dragMode,
      } as any,
    });

    // ── NavController: preset-specific pointer and wheel behaviour ───────────
    if (this.navController) {
      this.navController.update(settings, dims);
    } else {
      this.navController = new NavController(
        {
          getDeck: () => this.deck,
          getViewState: () => this.viewState as OrbitViewState,
          setViewState: (vs: OrbitViewState) => {
            this.viewState = vs;
            this.deck.setProps({ viewState: vs as any });
          },
          container: this.container,
          getTool: () => this.getTool?.() ?? 'pan',
        },
        settings,
        dims,
      );
    }
  }

  /** Destroy the NavController (called when the renderer is torn down). */
  destroyNavController(): void {
    this.navController?.destroy();
    this.navController = null;
  }

  /** Find the world position of a point by its index in the latest point set. */
  private findPointPosition(idx: number): number[] | null {
    // Search the sets in reverse (last set is drawn on top).
    for (let si = this.sets.length - 1; si >= 0; si--) {
      const s = this.sets[si];
      const nd = s.positionStride ?? 2;
      if (idx < s.length) {
        // x, y (and z in 3D), so the hover ring sits on the point in both views.
        return Array.from(s.positions.subarray(nd * idx, nd * idx + nd));
      }
    }
    return null;
  }

  toDataURL(background: string): string {
    this.deck.redraw('export');
    const canvas = (this.deck as any).getCanvas?.() ?? this.container.querySelector('canvas');
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d')!;
    g.fillStyle = background;
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Render the current frame to a PNG and resolve with its bytes. */
  toPngBytes(background: string): Promise<Uint8Array> {
    this.deck.redraw('export');
    const canvas = (this.deck as any).getCanvas?.() ?? this.container.querySelector('canvas');
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d')!;
    g.fillStyle = background;
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    return new Promise<Uint8Array>((resolve, reject) => {
      out.toBlob((blob) => {
        if (!blob) {
          reject(new Error('canvas.toBlob returned null'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, 'image/png');
    });
  }

  /** Like toPngBytes, but also composites the title overlay and annotations (A1, A4). */
  async toPngBytesWithOverlay(background: string, overlay: OverlayState): Promise<Uint8Array> {
    // Load the title font before compositing so it is available on the canvas.
    const fontFamily = overlay.titleOverlay?.fontFamily?.trim();
    if (fontFamily) {
      try {
        await ensureFont(fontFamily, [400, 700]);
        const fontSize = overlay.titleOverlay?.fontSize ?? 24;
        await document.fonts.load(`700 ${fontSize}px '${fontFamily}'`);
      } catch {
        // Font unavailable — fall back to sans-serif silently.
      }
    }

    this.deck.redraw('export');
    const canvas = (this.deck as any).getCanvas?.() ?? this.container.querySelector('canvas');
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d')!;
    g.fillStyle = background;
    g.fillRect(0, 0, out.width, out.height);

    g.drawImage(canvas, 0, 0);

    // A12: draw glow *over* the deck.gl canvas so soft halos are visible in the
    // exported PNG (matches the live z-index:2 stacking order in GlowOverlay.svelte).
    if (overlay.glowCanvas && overlay.glowCanvas.width > 0) {
      g.drawImage(overlay.glowCanvas, 0, 0, out.width, out.height);
    }

    // Build annotation screen positions for compositing.
    // B5: box position = projectWorld(worldX + offsetX, worldY + offsetY) (world-unit offsets).
    const dpr = window.devicePixelRatio || 1;
    const annotationsWithPos = [...overlay.annotations.values()].flatMap((ann) => {
      const pt = this.projectWorld(ann.worldX, ann.worldY);
      if (!pt) return [];
      const boxPt = this.projectWorld(ann.worldX + ann.offsetX, ann.worldY + ann.offsetY) ?? pt;
      return [{ ann, screenX: pt[0], screenY: pt[1], boxX: boxPt[0], boxY: boxPt[1] }];
    });

    await compositeOverlay(g, {
      cssWidth: this.container.clientWidth,
      cssHeight: this.container.clientHeight,
      dpr,
      title: overlay.titleOverlay,
      annotations: annotationsWithPos,
      aroundLabels: overlay.aroundLabels,
      leaderStyle: overlay.leaderStyle,
      leaderColor: overlay.leaderColor,
      leaderWidth: overlay.leaderWidth,
      labelFontFamily: overlay.labelFontFamily,
    });

    return new Promise<Uint8Array>((resolve, reject) => {
      out.toBlob((blob) => {
        if (!blob) {
          reject(new Error('canvas.toBlob returned null'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, 'image/png');
    });
  }

  /**
   * CPU-side count of points that would pass the current filter (useful for test assertions
   * without needing GPU pixel reads).  Returns the total point count when no filter is active.
   */
  get filterPassCount(): number {
    let total = 0;
    for (let si = 0; si < this.sets.length; si++) {
      const filter = this.filters[si] ?? null;
      // A filter with a precomputed array must always be counted precisely,
      // even when hidden.size === 0 (the precomputed values carry histogram bits).
      if (!filter || (filter.hidden.size === 0 && !filter.precomputed)) {
        total += this.sets[si]?.length ?? 0;
      } else {
        const vals = buildFilterValues(filter);
        for (const v of vals) {
          if (v > 0.5) total++;
        }
      }
    }
    return total;
  }

  destroy(): void {
    // Clean up NavController before finalizing.
    this.navController?.destroy();
    this.navController = null;
    this.deck.finalize();
  }
}

/**
 * Build a Float32Array of filter values (1 = visible, 0 = hidden) for a point set.
 * Uses precomputed values when available (supports combined legend + histogram filters).
 */
function buildFilterValues(filter: FilterAttribute): Float32Array {
  if (filter.precomputed) return filter.precomputed;
  const n = filter.codes.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = filter.hidden.has(filter.codes[i]) ? 0 : 1;
  }
  return out;
}
