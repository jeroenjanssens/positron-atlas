import { Deck, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';

export interface PointSet {
  id: string;
  /** Interleaved x,y. */
  positions: Float32Array;
  /** RGBA per point. */
  colors: Uint8Array;
  length: number;
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

  /** Fit the view to the given bounds unless the user has panned/zoomed (force overrides). */
  fit(b: [number, number, number, number], force = false): void {
    if (this.userMoved && !force) {
      return;
    }
    if (force) {
      this.userMoved = false;
    }
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const dx = Math.max(b[2] - b[0], 1e-6);
    const dy = Math.max(b[3] - b[1], 1e-6);
    const zoom = Math.log2(Math.min(w / dx, h / dy) * 0.9);
    this.viewState = { target: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], zoom };
    this.deck.setProps({ viewState: this.viewState as any });
  }

  private render(): void {
    const { pointSize, opacity, mode } = this.style;
    const density = mode === 'density';
    const layers = this.sets
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
