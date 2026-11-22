/**
 * NavController — custom pointer and wheel handler for navigation presets (item 1, B1).
 *
 * deck.gl's built-in OrbitController handles:
 *   2D: left-drag pan (dragMode:'pan'), right-drag rotate (alternateMode).
 *   3D: left-drag orbit (dragMode:'rotate'), right-drag pan (alternateMode).
 *
 * NavController adds what deck.gl cannot do natively:
 *   • Ctrl+left-drag → 2D rotate (all presets where right-drag rotates).
 *   • Middle-drag → pan 2D (CAD) or orbit 3D (CAD/molecular).
 *   • Shift+middle-drag → pan 3D (CAD).
 *   • Space+drag → pan 2D (Design preset).
 *   • emulateMiddleButton: Alt+left → middle behaviour.
 *   • zoomToCursor=false: scroll zooms to view centre instead of cursor.
 *   • invertZoom: flip the scroll-to-zoom direction.
 *   • scrollGesture=pan: two-finger scroll pans, rotation-aware; Ctrl+scroll zooms.
 *
 * The controller intercepts events on the deck.gl canvas (bubble phase).  Intercepted
 * events call stopPropagation() so deck.gl's EventManager (which listens on the container
 * in bubble phase) does not also process them.
 *
 * See docs/napari-plan.md §1.2 preset table and Q10.
 */

import type { OrbitViewState } from '@deck.gl/core';
import type { NavigationSettings } from '../../shared/protocol';

/** Rotation sensitivity: degrees per pixel of horizontal drag. */
const ROTATE_DEG_PER_PX = 0.5;
/** 3D tilt sensitivity: degrees per pixel of vertical drag. */
const TILT_DEG_PER_PX = 0.3;

export interface NavControllerContext {
  /** Return the deck.gl Deck instance (for viewport access). */
  getDeck: () => any;
  /** Return the current OrbitViewState. */
  getViewState: () => OrbitViewState;
  /** Set a new OrbitViewState.  Calls deck.setProps and updates the renderer's cached viewState. */
  setViewState: (vs: OrbitViewState) => void;
  /** The container element (parent of the canvas). */
  container: HTMLElement;
}

type CustomDragType = 'rotate-2d' | 'pan' | 'orbit-3d';

interface ActiveDrag {
  type: CustomDragType;
  pointerId: number;
  lastX: number;
  lastY: number;
}

export class NavController {
  private ctx: NavControllerContext;
  private settings: NavigationSettings;
  private dims: 2 | 3;

  private canvas: HTMLCanvasElement | null = null;
  private activeDrag: ActiveDrag | null = null;
  private spaceDown = false;

  // All registered listeners so we can detach them cleanly.
  private canvasListeners: Array<[string, EventListener, boolean]> = [];
  private windowListeners: Array<[string, EventListener]> = [];

  // Wheel handler: null = deck.gl handles natively.
  private wheelHandler: ((e: WheelEvent) => void) | null = null;

  constructor(ctx: NavControllerContext, settings: NavigationSettings, dims: 2 | 3) {
    this.ctx = ctx;
    this.settings = settings;
    this.dims = dims;
    this.canvas = this.findCanvas();
    this.attach();
  }

  /** Update settings and/or dims after construction.  Reattaches all listeners. */
  update(settings: NavigationSettings, dims: 2 | 3): void {
    this.settings = settings;
    this.dims = dims;
    // Re-find canvas in case it was recreated (dimension switch).
    const newCanvas = this.findCanvas();
    if (newCanvas !== this.canvas) {
      this.canvas = newCanvas;
    }
    this.detach();
    this.attach();
  }

  destroy(): void {
    this.detach();
  }

  // ---------------------------------------------------------------------------
  // Public pan helper (used by scroll-to-pan and by the renderer's panByFraction
  // for consistency; exposed so tests can call it directly).
  // ---------------------------------------------------------------------------

  /**
   * Pan the view by (screenDX, screenDY) CSS pixels in screen space.
   * Rotation-aware: uses the deck.gl viewport's unproject so the map moves in the
   * screen direction regardless of the current 2D rotation.
   */
  panByScreenDelta(screenDX: number, screenDY: number): void {
    const deck = this.ctx.getDeck();
    const vs = this.ctx.getViewState();
    const vp = deck?.getViewports?.()[0];
    if (vp) {
      const cx = vp.width / 2;
      const cy = vp.height / 2;
      const c = vp.unproject([cx, cy]);
      const p = vp.unproject([cx + screenDX, cy + screenDY]);
      const target = vs.target as number[];
      this.ctx.setViewState({
        ...vs,
        target: [target[0] + (c[0] - p[0]), target[1] + (c[1] - p[1]), target[2] ?? 0] as [number, number, number],
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findCanvas(): HTMLCanvasElement | null {
    return this.ctx.container.querySelector('canvas');
  }

  private addCanvas(type: string, fn: EventListener, capture = false): void {
    if (!this.canvas) return;
    this.canvas.addEventListener(type, fn, capture);
    this.canvasListeners.push([type, fn, capture]);
  }

  private addWindow(type: string, fn: EventListener): void {
    window.addEventListener(type, fn);
    this.windowListeners.push([type, fn]);
  }

  private detach(): void {
    for (const [type, fn, capture] of this.canvasListeners) {
      this.canvas?.removeEventListener(type, fn, capture);
    }
    this.canvasListeners = [];
    for (const [type, fn] of this.windowListeners) {
      window.removeEventListener(type, fn);
    }
    this.windowListeners = [];
    this.activeDrag = null;
    this.spaceDown = false;

    // Remove wheel handler
    if (this.wheelHandler && this.canvas) {
      this.canvas.removeEventListener('wheel', this.wheelHandler);
      this.wheelHandler = null;
    }
  }

  private attach(): void {
    if (!this.canvas) return;

    // ---- Space key tracking (Design preset pan) --------------------------------
    this.addWindow('keydown', ((e: KeyboardEvent) => {
      if (e.code === 'Space') this.spaceDown = true;
    }) as EventListener);
    this.addWindow('keyup', ((e: KeyboardEvent) => {
      if (e.code === 'Space') { this.spaceDown = false; }
    }) as EventListener);
    this.addWindow('blur', (() => { this.spaceDown = false; }) as EventListener);

    // ---- Pointer events on canvas (bubble phase, fires before container) -------
    this.addCanvas('pointerdown', this.onPointerDown as EventListener);
    this.addCanvas('pointermove', this.onPointerMove as EventListener);
    this.addCanvas('pointerup', this.onPointerUp as EventListener);
    this.addCanvas('pointercancel', this.onPointerCancel as EventListener);
    // Prevent context menu on right-click so right-drag is uninterrupted.
    this.addCanvas('contextmenu', ((e: Event) => {
      if (this.dims === 2) e.preventDefault();
    }) as EventListener);

    // ---- Wheel interceptor (attached when non-default behaviour is needed) ------
    this.updateWheelHandler();
  }

  // ---------------------------------------------------------------------------
  // Pointer event handlers
  // ---------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    // We only intercept button=0 (left) or button=1 (middle) here.
    // Right-drag (button=2) is handled by deck.gl's alternateMode.
    const { settings, dims } = this;

    // ---- Middle button (button=1) -------------------------------------------
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      this.startCustomDrag(e, this.middleDragType(e.shiftKey));
      return;
    }

    // ---- Left button (button=0) custom cases ----------------------------------
    if (e.button !== 0) return;

    // emulateMiddleButton: Alt+left → middle behaviour
    if (settings.emulateMiddleButton && e.altKey && !e.ctrlKey && !this.spaceDown) {
      e.preventDefault();
      e.stopPropagation();
      this.startCustomDrag(e, this.middleDragType(e.shiftKey));
      return;
    }

    // Ctrl+left-drag → rotate 2D (dataMap, molecular, design; CAD does not rotate on ctrl+drag)
    if (dims === 2 && e.ctrlKey && !e.altKey && settings.preset !== 'cad') {
      e.preventDefault();
      e.stopPropagation();
      this.startCustomDrag(e, 'rotate-2d');
      return;
    }

    // Space+drag → pan 2D (Design preset)
    if (dims === 2 && this.spaceDown && settings.preset === 'design') {
      e.preventDefault();
      e.stopPropagation();
      this.startCustomDrag(e, 'pan');
      return;
    }

    // All other left-drag cases: let deck.gl handle (pan in 2D, orbit in 3D).
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.activeDrag || e.pointerId !== this.activeDrag.pointerId) return;
    const dx = e.clientX - this.activeDrag.lastX;
    const dy = e.clientY - this.activeDrag.lastY;
    this.activeDrag.lastX = e.clientX;
    this.activeDrag.lastY = e.clientY;

    const vs = this.ctx.getViewState();

    switch (this.activeDrag.type) {
      case 'rotate-2d': {
        // Horizontal drag rotates the 2D map (rotationOrbit).
        const delta = dx * ROTATE_DEG_PER_PX;
        this.ctx.setViewState({
          ...vs,
          rotationOrbit: ((vs.rotationOrbit ?? 0) + delta) % 360,
        });
        break;
      }
      case 'pan': {
        this.panByScreenDelta(dx, dy);
        break;
      }
      case 'orbit-3d': {
        // Horizontal → rotationOrbit; vertical → rotationX.
        const orbitDelta = dx * ROTATE_DEG_PER_PX;
        const tiltDelta = dy * TILT_DEG_PER_PX;
        this.ctx.setViewState({
          ...vs,
          rotationOrbit: ((vs.rotationOrbit ?? 0) + orbitDelta) % 360,
          rotationX: Math.max(0, Math.min(90, (vs.rotationX ?? 20) + tiltDelta)),
        });
        break;
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.activeDrag && e.pointerId === this.activeDrag.pointerId) {
      this.activeDrag = null;
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.activeDrag && e.pointerId === this.activeDrag.pointerId) {
      this.activeDrag = null;
    }
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private startCustomDrag(e: PointerEvent, type: CustomDragType): void {
    this.canvas!.setPointerCapture(e.pointerId);
    this.activeDrag = { type, pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
  }

  /**
   * What should a middle-drag do, given the current preset and dims?
   *
   * | Preset    | 2D        | 3D (no shift) | 3D (shift) |
   * |-----------|-----------|---------------|------------|
   * | cad       | pan       | orbit-3d      | pan        |
   * | molecular | pan       | pan           | pan        |
   * | dataMap   | pan       | pan           | pan        |
   * | design    | pan       | pan           | pan        |
   */
  private middleDragType(shiftKey: boolean): CustomDragType {
    const { settings, dims } = this;
    if (settings.preset === 'cad') {
      if (dims === 3) return shiftKey ? 'pan' : 'orbit-3d';
      return 'pan';
    }
    // molecular / dataMap / design: middle-drag pans
    return 'pan';
  }

  // ---------------------------------------------------------------------------
  // Wheel interceptor
  // ---------------------------------------------------------------------------

  private updateWheelHandler(): void {
    if (this.wheelHandler && this.canvas) {
      this.canvas.removeEventListener('wheel', this.wheelHandler);
      this.wheelHandler = null;
    }

    const { settings } = this;
    // Interceptor needed when any non-default wheel behaviour is active.
    const needsInterceptor =
      settings.invertZoom ||
      !settings.zoomToCursor ||
      settings.scrollGesture === 'pan';

    if (!needsInterceptor || !this.canvas) return;

    this.wheelHandler = this.handleWheel;
    this.canvas.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  private handleWheel = (e: WheelEvent): void => {
    const { settings } = this;
    const isCtrl = e.ctrlKey || e.metaKey;

    // scrollGesture=pan: two-finger scroll pans; Ctrl+scroll (or Cmd+scroll) zooms.
    if (settings.scrollGesture === 'pan' && !isCtrl) {
      e.preventDefault();
      e.stopPropagation();
      this.panByScreenDelta(e.deltaX, e.deltaY);
      return;
    }

    // Zoom cases (invertZoom or zoomToCursor=false need interception).
    if (settings.invertZoom || !settings.zoomToCursor) {
      e.preventDefault();
      e.stopPropagation();

      let rawDelta = -(e.deltaY || e.deltaX);
      if (settings.invertZoom) rawDelta = -rawDelta;

      // Convert raw delta to zoom increment (same curve as deck.gl's built-in).
      const speed = 0.01;
      let scale = 2 / (1 + Math.exp(-Math.abs(rawDelta * speed)));
      if (rawDelta < 0 && scale !== 0) scale = 1 / scale;
      const zoomDelta = Math.log2(scale);
      const vs = this.ctx.getViewState();
      const newZoom = (vs.zoom as number) + zoomDelta;

      if (settings.zoomToCursor) {
        // invertZoom=true + zoomToCursor=true: invert direction but keep cursor fixed.
        this.applyZoomToCursor(newZoom, zoomDelta, e);
      } else {
        // zoomToCursor=false: zoom to view centre (target stays put).
        this.ctx.setViewState({ ...vs, zoom: newZoom });
      }
      return;
    }

    // All other cases (scrollGesture=zoom, !invertZoom, zoomToCursor=true): let deck.gl handle.
  };

  /**
   * Apply a zoom increment that keeps the screen position of the cursor
   * fixed in world coordinates.  Uses the viewport's unproject so it is
   * rotation-aware.
   *
   *   factor = 1 - 2^(-zoomDelta)
   *   newTarget = target + (cursorWorld - target) * factor
   *
   * Derivation: for the cursor screen position (mx, my) to map to the same
   * world point after zoom, the target must shift by (cursorWorld - target)
   * scaled by the fractional zoom change.
   */
  private applyZoomToCursor(newZoom: number, zoomDelta: number, e: WheelEvent): void {
    const vs = this.ctx.getViewState();
    const deck = this.ctx.getDeck();
    const vp = deck?.getViewports?.()[0];
    if (vp && this.canvas) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const [wx, wy] = vp.unproject([mx, my]);
      const factor = 1 - Math.pow(2, -zoomDelta);
      const target = vs.target as number[];
      this.ctx.setViewState({
        ...vs,
        zoom: newZoom,
        target: [
          target[0] + (wx - target[0]) * factor,
          target[1] + (wy - target[1]) * factor,
          target[2] ?? 0,
        ] as [number, number, number],
      });
    } else {
      this.ctx.setViewState({ ...vs, zoom: newZoom });
    }
  }
}
