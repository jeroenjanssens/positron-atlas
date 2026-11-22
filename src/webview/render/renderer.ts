import { Deck, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { CollisionFilterExtension, DataFilterExtension } from '@deck.gl/extensions';

export interface PointSet {
  id: string;
  /** Interleaved x,y. */
  positions: Float32Array;
  /** RGBA per point. */
  colors: Uint8Array;
  length: number;
}

/** A text label on the map (world coordinates, size in pixels). */
export interface MapLabel {
  text: string;
  position: [number, number];
  size: number;
  color: [number, number, number, number];
  /** Higher wins when labels overlap (CollisionFilterExtension). */
  priority: number;
}

export interface LabelStyle {
  /** Outline (halo) color, usually the plot background, as RGBA. */
  outline: [number, number, number, number];
  fontFamily: string;
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

/** deck.gl scatter renderer with binary attributes and a controlled orthographic view. */
export class ScatterRenderer {
  private deck: Deck<OrthographicView>;
  private sets: PointSet[] = [];
  private style: RenderStyle = { pointSize: 3, opacity: 0.8, mode: 'points' };
  private viewState: OrthographicViewState = { target: [0, 0, 0], zoom: 0 };
  private version = 0;
  private pointerListeners: ((p: { x: number; y: number; world: [number, number] } | null) => void)[] = [];
  private userMoved = false;
  private labels: MapLabel[] = [];
  private outlines: [number, number][][] = [];
  private outlineColor: [number, number, number] = [200, 200, 200];
  private labelStyle: LabelStyle = { outline: [30, 30, 30, 255], fontFamily: 'sans-serif' };
  private readonly collision = new CollisionFilterExtension();
  private readonly dataFilter = new DataFilterExtension({ filterSize: 1 });
  /** Prepared-row index of the hovered point (for the ring), or -1. */
  private hoveredIdx = -1;
  /** Prepared-row index of the pinned point (for the ring), or -1. */
  private pinnedIdx = -1;
  /** Shared all-ones filter values (no category hidden), grown as needed. */
  private ones = new Float32Array(0);

  private allVisible(n: number): Float32Array {
    if (this.ones.length < n) this.ones = new Float32Array(Math.max(n, this.ones.length * 2)).fill(1);
    return this.ones.subarray(0, n);
  }

  /** Per-point-set filter attributes (category codes + hidden set). */
  private filters: (FilterAttribute | null)[] = [];
  /** Per-point-set search match mask (1 = match, 0 = non-match).  Null per set means no search active. */
  private searchFilters: (Float32Array | null)[] = [];

  constructor(private readonly container: HTMLElement) {
    this.deck = new Deck({
      parent: container,
      views: new OrthographicView({ id: 'ortho', flipY: false }),
      viewState: this.viewState as any,
      controller: { scrollZoom: { speed: 0.01, smooth: false }, doubleClickZoom: true, dragRotate: false } as any,
      onViewStateChange: ({ viewState, interactionState }: any) => {
        this.viewState = viewState;
        if (interactionState?.isDragging || interactionState?.isZooming || interactionState?.isPanning) {
          this.userMoved = true;
        }
        this.deck.setProps({ viewState });
        return viewState;
      },
      onHover: (info: any) => {
        if (!info || info.x < 0 || !info.coordinate) {
          this.pointerListeners.forEach((l) => l(null));
          return;
        }
        const world: [number, number] = [info.coordinate[0], info.coordinate[1]];
        this.pointerListeners.forEach((l) => l({ x: info.x, y: info.y, world }));
      },
      getCursor: ({ isDragging }: any) => (isDragging ? 'grabbing' : 'crosshair'),
      useDevicePixels: true,
      layers: [],
    } as any);
  }

  onPointer(cb: (p: { x: number; y: number; world: [number, number] } | null) => void): void {
    this.pointerListeners.push(cb);
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

  /** Replace the text labels (an empty list removes them). */
  setLabels(labels: MapLabel[], style?: Partial<LabelStyle>): void {
    this.labels = labels;
    if (style) {
      this.labelStyle = { ...this.labelStyle, ...style };
    }
    this.render();
  }

  /** Replace the cluster outlines (rings in world coordinates; an empty list removes them). */
  setOutlines(rings: [number, number][][], color?: [number, number, number]): void {
    if (rings.length === 0 && this.outlines.length === 0) {
      return;
    }
    this.outlines = rings;
    if (color) {
      this.outlineColor = color;
    }
    this.render();
  }

  /** Fit the view to the given bounds unless the user has panned/zoomed (force overrides). */
  fit(b: [number, number, number, number], force = false, padRight = 0): void {
    if (this.userMoved && !force) {
      return;
    }
    if (force) {
      this.userMoved = false;
    }
    const fullW = this.container.clientWidth || 800;
    const pad = fullW - padRight > 200 ? padRight : 0;
    const w = fullW - pad;
    const h = this.container.clientHeight || 600;
    const dx = Math.max(b[2] - b[0], 1e-6);
    const dy = Math.max(b[3] - b[1], 1e-6);
    const scale = Math.min(w / dx, h / dy) * 0.9;
    const zoom = Math.log2(scale);
    // Shift the center left so the data sits in the area not covered by the legend.
    const cx = (b[0] + b[2]) / 2 + pad / 2 / scale;
    this.viewState = { target: [cx, (b[1] + b[3]) / 2, 0], zoom };
    this.deck.setProps({ viewState: this.viewState as any });
  }

  private render(): void {
    const { pointSize, opacity, mode } = this.style;
    const density = mode === 'density';
    const searchActive = this.searchFilters.some((sf) => sf !== null);
    const layers: (ScatterplotLayer | PolygonLayer<[number, number][]> | TextLayer<MapLabel>)[] = [];
    for (let si = 0; si < this.sets.length; si++) {
      const s = this.sets[si];
      if (s.length === 0) continue;
      const filter = this.filters[si] ?? null;
      const hasFilter = filter !== null && filter.hidden.size > 0;
      // Always attach the DataFilterExtension and a filter value per point (1 = visible,
      // 0 = hidden; all ones without a filter). Adding or removing a layer extension after
      // the layer exists does not rebuild its shaders, which hid every point.
      const legendValues = hasFilter ? buildFilterValues(filter) : this.allVisible(s.length);
      const sf = this.searchFilters[si] ?? null;
      if (searchActive && sf !== null) {
        // Two-pass: faded base layer for all legend-visible points, bright highlight for matches.
        // Base pass: all legend-visible points at reduced opacity.
        layers.push(new ScatterplotLayer({
          id: `points-${s.id}-base`,
          data: {
            length: s.length,
            attributes: {
              getPosition: { value: s.positions, size: 2 },
              getFillColor: { value: s.colors, size: 4, normalized: true },
              getFilterValue: { value: legendValues, size: 1 },
            },
          } as any,
          radiusUnits: 'pixels',
          getRadius: pointSize / 2,
          radiusMinPixels: 0.5,
          stroked: false,
          filled: true,
          antialiasing: !density,
          opacity: density ? Math.max(0.02, opacity * 0.03) : opacity * 0.18,
          pickable: false,
          parameters: (density ? ADDITIVE : NORMAL) as any,
          updateTriggers: { getPosition: this.version, getFillColor: this.version, getFilterValue: this.version },
          extensions: [this.dataFilter],
          filterRange: [0.5, 1.5] as [number, number],
        }));
        // Highlight pass: only matching points at full opacity.
        layers.push(new ScatterplotLayer({
          id: `points-${s.id}-highlight`,
          data: {
            length: s.length,
            attributes: {
              getPosition: { value: s.positions, size: 2 },
              getFillColor: { value: s.colors, size: 4, normalized: true },
              getFilterValue: { value: sf, size: 1 },
            },
          } as any,
          radiusUnits: 'pixels',
          getRadius: pointSize / 2,
          radiusMinPixels: 0.5,
          stroked: false,
          filled: true,
          antialiasing: !density,
          opacity: density ? Math.max(0.02, opacity * 0.15) : opacity,
          pickable: false,
          parameters: (density ? ADDITIVE : NORMAL) as any,
          updateTriggers: { getPosition: this.version, getFillColor: this.version, getFilterValue: this.version },
          extensions: [this.dataFilter],
          filterRange: [0.5, 1.5] as [number, number],
        }));
      } else {
        // No search: single layer with legend filter.
        layers.push(new ScatterplotLayer({
          id: `points-${s.id}`,
          data: {
            length: s.length,
            attributes: {
              getPosition: { value: s.positions, size: 2 },
              getFillColor: { value: s.colors, size: 4, normalized: true },
              getFilterValue: { value: legendValues, size: 1 },
            },
          } as any,
          radiusUnits: 'pixels',
          getRadius: pointSize / 2,
          radiusMinPixels: 0.5,
          stroked: false,
          filled: true,
          antialiasing: !density,
          opacity: density ? Math.max(0.02, opacity * 0.15) : opacity,
          pickable: false,
          parameters: (density ? ADDITIVE : NORMAL) as any,
          updateTriggers: { getPosition: this.version, getFillColor: this.version, getFilterValue: this.version },
          // filterRange [0.5, 1.5] shows values == 1 (visible) and hides values == 0 (hidden).
          extensions: [this.dataFilter],
          filterRange: [0.5, 1.5] as [number, number],
        }));
      }
    }
    if (this.outlines.length) {
      const [r, g, b] = this.outlineColor;
      layers.push(
        new PolygonLayer<[number, number][]>({
          id: 'outlines',
          data: this.outlines,
          getPolygon: (d: [number, number][]) => d,
          stroked: true,
          filled: true,
          getFillColor: [r, g, b, 14],
          getLineColor: [r, g, b, 150],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.25,
          pickable: false,
          parameters: NORMAL as any,
        } as any),
      );
    }
    // Hover ring (A5): draw a ring around the hovered and/or pinned point.
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
            getPosition: (d: [number, number]) => [d[0], d[1]],
            radiusUnits: 'pixels',
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
    if (this.labels.length) {
      const { outline, fontFamily } = this.labelStyle;
      layers.push(
        new TextLayer<MapLabel>({
          id: 'labels',
          data: this.labels,
          getText: (d: MapLabel) => d.text,
          getPosition: (d: MapLabel) => d.position,
          getSize: (d: MapLabel) => d.size,
          getColor: (d: MapLabel) => d.color,
          sizeUnits: 'pixels',
          fontFamily,
          fontWeight: 600,
          characterSet: 'auto',
          // deck.gl divides outlineWidth by the SDF radius: 10/16 gives a halo of about 15% of
          // the font size, enough to read colored text on top of points of the same color.
          fontSettings: { sdf: true, fontSize: 64, buffer: 16, radius: 16 },
          outlineWidth: 10,
          outlineColor: outline,
          lineHeight: 0.95,
          maxWidth: 9,
          wordBreak: 'break-word',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          pickable: false,
          // Hide labels that would overlap a label with a higher priority (bigger group).
          extensions: [this.collision],
          collisionEnabled: true,
          getCollisionPriority: (d: MapLabel) => d.priority,
          // Test collisions on slightly enlarged labels, so kept labels keep some space.
          collisionTestProps: { sizeScale: 1.4 },
          parameters: NORMAL as any,
        } as any),
      );
    }
    this.deck.setProps({ layers });
  }

  /** Find the world position of a point by its index in the latest point set. */
  private findPointPosition(idx: number): [number, number] | null {
    // Search the sets in reverse (last set is drawn on top).
    for (let si = this.sets.length - 1; si >= 0; si--) {
      const s = this.sets[si];
      if (idx < s.length) {
        return [s.positions[2 * idx], s.positions[2 * idx + 1]];
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

  /**
   * CPU-side count of points that would pass the current filter (useful for test assertions
   * without needing GPU pixel reads).  Returns the total point count when no filter is active.
   */
  get filterPassCount(): number {
    let total = 0;
    for (let si = 0; si < this.sets.length; si++) {
      const filter = this.filters[si] ?? null;
      if (!filter || filter.hidden.size === 0) {
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
    this.deck.finalize();
  }
}

/**
 * Build a Float32Array of filter values (1 = visible, 0 = hidden) for a point set,
 * based on the category codes and hidden set.
 */
function buildFilterValues(filter: FilterAttribute): Float32Array {
  const n = filter.codes.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = filter.hidden.has(filter.codes[i]) ? 0 : 1;
  }
  return out;
}
