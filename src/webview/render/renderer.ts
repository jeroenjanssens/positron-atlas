import { Deck, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { CollisionFilterExtension } from '@deck.gl/extensions';

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

  setPointSets(sets: PointSet[]): void {
    this.sets = sets;
    this.version++;
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
    const layers: (ScatterplotLayer | PolygonLayer<[number, number][]> | TextLayer<MapLabel>)[] = this.sets
      .filter((s) => s.length > 0)
      .map(
        (s) =>
          new ScatterplotLayer({
            id: `points-${s.id}`,
            data: {
              length: s.length,
              attributes: {
                getPosition: { value: s.positions, size: 2 },
                getFillColor: { value: s.colors, size: 4, normalized: true },
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
            updateTriggers: { getPosition: this.version, getFillColor: this.version },
          }),
      );
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

  destroy(): void {
    this.deck.finalize();
  }
}
