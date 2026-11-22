<script lang="ts">
  /**
   * ShapeLayer — pointer overlay for the shapes tool (B4, item 8).
   *
   * Handles:
   *  - Drawing new shapes (rect, ellipse, polygon, freehand, line, arrow, text)
   *  - Selecting and editing existing shapes (move, resize via 8 handles, rotate, delete)
   *  - All edits delegate to atlas.addShape / atlas.updateShape / atlas.removeShape
   *
   * Coordinates:
   *  - Everything in world space.  Screen ↔ world via atlas.renderer.unproject / projectWorld.
   *  - SVG handles are positioned using projectWorld().
   */

  import type { Atlas } from '../atlas.svelte';
  import type { Shape, ShapeStyle, RectShape, EllipseShape, LineShape } from '../atlas/shapes';
  import { makeRect, makeEllipse, makePolygon, makeFreehand, makeLine, makeArrow, makeText } from '../atlas/shapes';

  let { atlas }: { atlas: Atlas } = $props();

  const active = $derived(atlas.annotateTool === 'shapes');

  // ---- drawing state ----------------------------------------------------------
  type DrawMode = 'idle' | 'draw-rect' | 'draw-ellipse' | 'draw-polygon' | 'draw-freehand' | 'draw-line' | 'draw-arrow' | 'draw-text';
  type EditMode = 'idle' | 'move' | 'resize' | 'rotate';

  let drawMode = $state<DrawMode>('idle');
  let editMode = $state<EditMode>('idle');

  // In-progress shape drawing
  let drawStart = $state<[number, number] | null>(null);  // world coords
  let drawCurrent = $state<[number, number] | null>(null); // world coords
  let polyPoints = $state<[number, number][]>([]);
  let freePoints = $state<[number, number][]>([]);

  // Selection / editing
  let selectedId = $state<string | null>(null);
  let editHandle = $state<number>(-1);    // 0-7 = resize handles, 8 = rotate handle
  let editStart = $state<[number, number] | null>(null);  // world
  let editOrigShape = $state<Shape | null>(null);

  // DOM
  let el = $state<SVGSVGElement>();
  let svgW = $state(800);
  let svgH = $state(600);

  // Keep SVG size in sync
  $effect(() => {
    if (!el) return;
    const obs = new ResizeObserver(() => {
      svgW = el!.clientWidth;
      svgH = el!.clientHeight;
    });
    obs.observe(el);
    return () => obs.disconnect();
  });

  const selectedShape = $derived(atlas.shapes.find((s) => s.id === selectedId) ?? null);

  function currentStyle(): ShapeStyle {
    return {
      strokeColor: [255, 80, 80, 220],
      fillColor: [255, 80, 80, 40],
      strokeWidth: 2,
      opacity: 1,
      dash: [],
      arrowHead: 'none',
    };
  }

  // ---- coordinate helpers -----------------------------------------------------
  function world(e: PointerEvent): [number, number] {
    if (!atlas.renderer || !el) return [0, 0];
    const r = el.getBoundingClientRect();
    return atlas.renderer.unproject(e.clientX - r.left, e.clientY - r.top);
  }
  function screen(wx: number, wy: number): [number, number] | null {
    return atlas.renderer?.projectWorld(wx, wy) ?? null;
  }

  // ---- polygon screen vertices for SVG rendering ------------------------------
  function shapeScreenPoly(shape: Shape): string {
    if (shape.kind === 'rect') {
      const r = shape as RectShape;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const hw = r.w / 2;
      const hh = r.h / 2;
      const angle = (r.rotation ?? 0) * Math.PI / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      return corners.map(([dx, dy]) => {
        const wx = cx + dx * cos - dy * sin;
        const wy = cy + dx * sin + dy * cos;
        const s = screen(wx, wy);
        return s ? `${s[0]},${s[1]}` : '0,0';
      }).join(' ');
    }
    if (shape.kind === 'ellipse') {
      const e = shape as EllipseShape;
      const segs = 48;
      const pts: string[] = [];
      for (let i = 0; i < segs; i++) {
        const t = (2 * Math.PI * i) / segs;
        const wx = e.cx + e.rx * Math.cos(t);
        const wy = e.cy + e.ry * Math.sin(t);
        const s = screen(wx, wy);
        if (s) pts.push(`${s[0]},${s[1]}`);
      }
      return pts.join(' ');
    }
    if (shape.kind === 'polygon' || shape.kind === 'freehand') {
      return (shape as any).vertices.map((v: [number, number]) => {
        const s = screen(v[0], v[1]);
        return s ? `${s[0]},${s[1]}` : '0,0';
      }).join(' ');
    }
    return '';
  }

  function shapeScreenLine(shape: Shape): string {
    if (shape.kind === 'line' || shape.kind === 'arrow') {
      return (shape as any).points.map((v: [number, number]) => {
        const s = screen(v[0], v[1]);
        return s ? `${s[0]},${s[1]}` : '0,0';
      }).join(' ');
    }
    return '';
  }

  // ---- in-progress drawing preview -------------------------------------------
  let previewPoly = $derived.by(() => {
    if (!drawStart || !drawCurrent) return '';
    const [x0, y0] = drawStart;
    const [x1, y1] = drawCurrent;
    if (drawMode === 'draw-rect') {
      const pts: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      return pts.map((v) => { const s = screen(v[0], v[1]); return s ? `${s[0]},${s[1]}` : '0,0'; }).join(' ');
    }
    if (drawMode === 'draw-ellipse') {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2;
      const ry = Math.abs(y1 - y0) / 2;
      const segs = 32;
      const pts: string[] = [];
      for (let i = 0; i < segs; i++) {
        const t = (2 * Math.PI * i) / segs;
        const wx = cx + rx * Math.cos(t);
        const wy = cy + ry * Math.sin(t);
        const s = screen(wx, wy);
        if (s) pts.push(`${s[0]},${s[1]}`);
      }
      return pts.join(' ');
    }
    return '';
  });

  let previewPolyPoints = $derived.by(() => {
    if (drawMode !== 'draw-polygon') return '';
    const pts = polyPoints.map((v) => { const s = screen(v[0], v[1]); return s ? `${s[0]},${s[1]}` : '0,0'; });
    if (drawCurrent) {
      const s = screen(drawCurrent[0], drawCurrent[1]);
      if (s) pts.push(`${s[0]},${s[1]}`);
    }
    return pts.join(' ');
  });

  let previewFreehand = $derived.by(() => {
    if (drawMode !== 'draw-freehand') return '';
    return freePoints.map((v) => { const s = screen(v[0], v[1]); return s ? `${s[0]},${s[1]}` : '0,0'; }).join(' ');
  });

  let previewLine = $derived.by(() => {
    if (drawMode !== 'draw-line' && drawMode !== 'draw-arrow') return '';
    const pts = polyPoints.map((v) => { const s = screen(v[0], v[1]); return s ? `${s[0]},${s[1]}` : '0,0'; });
    if (drawCurrent) {
      const s = screen(drawCurrent[0], drawCurrent[1]);
      if (s) pts.push(`${s[0]},${s[1]}`);
    }
    return pts.join(' ');
  });

  // ---- edit handles: 8 resize + 1 rotate ------------------------------------
  function handlePositions(shape: Shape): ([number, number] | null)[] {
    if (!atlas.renderer) return [];
    if (shape.kind === 'rect') {
      const r = shape as RectShape;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const hw = r.w / 2;
      const hh = r.h / 2;
      const angle = (r.rotation ?? 0) * Math.PI / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const local: [number, number][] = [
        [-hw, -hh], [0, -hh], [hw, -hh],
        [hw, 0],
        [hw, hh], [0, hh], [-hw, hh],
        [-hw, 0],
        [0, -hh - 20 / (atlas.renderer.worldPerPixel() * 1 || 1)] // rotate handle
      ];
      return local.map(([dx, dy]) => screen(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos));
    }
    if (shape.kind === 'ellipse') {
      const e = shape as EllipseShape;
      const pts: [number, number][] = [
        [e.cx - e.rx, e.cy],
        [e.cx, e.cy - e.ry],
        [e.cx + e.rx, e.cy],
        [e.cx, e.cy + e.ry],
        [e.cx, e.cy - e.ry - 20 / (atlas.renderer.worldPerPixel() || 1)], // rotate
      ];
      return pts.map((v) => screen(v[0], v[1]));
    }
    return [];
  }

  // ---- pointer events ---------------------------------------------------------
  function onDown(e: PointerEvent) {
    if (e.button !== 0 || !atlas.renderer || !el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const [wx, wy] = world(e);

    // Check if clicking on a shape (select it) or start drawing.
    if (drawMode === 'idle') {
      const hit = findShapeAt(wx, wy);
      if (hit) {
        selectedId = hit.id;
        editMode = 'move';
        editStart = [wx, wy];
        editOrigShape = { ...hit } as Shape;
        return;
      }
      // No hit: auto-start drawing the current type.
      selectedId = null;
      const type = atlas.shapeDrawType;
      if (type === 'rect') drawMode = 'draw-rect';
      else if (type === 'ellipse') drawMode = 'draw-ellipse';
      else if (type === 'polygon') drawMode = 'draw-polygon';
      else if (type === 'freehand') drawMode = 'draw-freehand';
      else if (type === 'line') drawMode = 'draw-line';
      else if (type === 'arrow') drawMode = 'draw-arrow';
      else if (type === 'text') {
        const style = currentStyle();
        const textShape = makeText(wx, wy, 'Text', 14, 'sans-serif', style);
        atlas.addShape(textShape);
        selectedId = textShape.id;
        return;
      }
    }

    if (drawMode === 'draw-rect' || drawMode === 'draw-ellipse') {
      drawStart = [wx, wy];
      drawCurrent = [wx, wy];
    } else if (drawMode === 'draw-polygon' || drawMode === 'draw-line' || drawMode === 'draw-arrow') {
      if (polyPoints.length === 0) polyPoints = [[wx, wy]];
      else polyPoints = [...polyPoints, [wx, wy]];
    } else if (drawMode === 'draw-freehand') {
      freePoints = [[wx, wy]];
    } else if (drawMode === 'draw-text') {
      const style = currentStyle();
      const textShape = makeText(wx, wy, 'Text', 14, 'sans-serif', style);
      atlas.addShape(textShape);
      selectedId = textShape.id;
      drawMode = 'idle';
    }
  }

  function onMove(e: PointerEvent) {
    if (!atlas.renderer || !el) return;
    const [wx, wy] = world(e);
    drawCurrent = [wx, wy];

    if (editMode === 'move' && editStart && editOrigShape && selectedId) {
      const dx = wx - editStart[0];
      const dy = wy - editStart[1];
      applyMove(selectedId, editOrigShape, dx, dy, false);
    }

    if (drawMode === 'draw-freehand' && freePoints.length > 0) {
      freePoints = [...freePoints, [wx, wy]];
    }
  }

  function onUp(e: PointerEvent) {
    const [wx, wy] = world(e);

    if (editMode === 'move' && editStart && editOrigShape && selectedId) {
      const dx = wx - editStart[0];
      const dy = wy - editStart[1];
      applyMove(selectedId, editOrigShape, dx, dy, true);
      editMode = 'idle';
      editStart = null;
      editOrigShape = null;
    }

    if (drawMode === 'draw-rect' && drawStart) {
      const [x0, y0] = drawStart;
      const x = Math.min(x0, wx);
      const y = Math.min(y0, wy);
      const w = Math.abs(wx - x0);
      const h = Math.abs(wy - y0);
      if (w > 0.01 && h > 0.01) {
        const shape = makeRect(x, y, w, h, currentStyle());
        atlas.addShape(shape);
        selectedId = shape.id;
      }
      drawStart = null;
      drawCurrent = null;
    }
    if (drawMode === 'draw-ellipse' && drawStart) {
      const [x0, y0] = drawStart;
      const cx = (x0 + wx) / 2;
      const cy = (y0 + wy) / 2;
      const rx = Math.abs(wx - x0) / 2;
      const ry = Math.abs(wy - y0) / 2;
      if (rx > 0.01 && ry > 0.01) {
        const shape = makeEllipse(cx, cy, rx, ry, currentStyle());
        atlas.addShape(shape);
        selectedId = shape.id;
      }
      drawStart = null;
      drawCurrent = null;
    }
    if (drawMode === 'draw-freehand' && freePoints.length >= 3) {
      const shape = makeFreehand([...freePoints], currentStyle());
      atlas.addShape(shape);
      selectedId = shape.id;
      freePoints = [];
    }
  }

  function onDblClick(e: MouseEvent) {
    if (!atlas.renderer || !el) return;
    const r = el.getBoundingClientRect();
    const [wx, wy] = atlas.renderer.unproject(e.clientX - r.left, e.clientY - r.top);

    if (drawMode === 'draw-polygon' && polyPoints.length >= 3) {
      const shape = makePolygon([...polyPoints], currentStyle());
      atlas.addShape(shape);
      selectedId = shape.id;
      polyPoints = [];
      drawCurrent = null;
    }
    if ((drawMode === 'draw-line' || drawMode === 'draw-arrow') && polyPoints.length >= 2) {
      const shape = drawMode === 'draw-arrow'
        ? makeArrow([...polyPoints], currentStyle())
        : makeLine([...polyPoints], currentStyle());
      atlas.addShape(shape);
      selectedId = shape.id;
      polyPoints = [];
      drawCurrent = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      drawStart = null;
      drawCurrent = null;
      polyPoints = [];
      freePoints = [];
      selectedId = null;
      editMode = 'idle';
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      atlas.removeShape(selectedId);
      selectedId = null;
    }
    // Copy/paste
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedId) {
      const shape = atlas.shapes.find((s) => s.id === selectedId);
      if (shape) (window as any).__clipboardShape = shape;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && (window as any).__clipboardShape) {
      const orig = (window as any).__clipboardShape as Shape;
      let copy: Shape;
      if (orig.kind === 'rect') copy = makeRect((orig as any).x + 5, (orig as any).y + 5, (orig as any).w, (orig as any).h, orig.style);
      else if (orig.kind === 'ellipse') copy = makeEllipse((orig as any).cx + 5, (orig as any).cy + 5, (orig as any).rx, (orig as any).ry, orig.style);
      else if (orig.kind === 'line') copy = makeLine((orig as any).points.map(([x, y]: [number,number]) => [x + 5, y + 5] as [number,number]), orig.style);
      else if (orig.kind === 'arrow') copy = makeArrow((orig as any).points.map(([x, y]: [number,number]) => [x + 5, y + 5] as [number,number]), orig.style);
      else if (orig.kind === 'polygon') copy = makePolygon((orig as any).vertices.map(([x, y]: [number,number]) => [x + 5, y + 5] as [number,number]), orig.style);
      else if (orig.kind === 'freehand') copy = makeFreehand((orig as any).vertices.map(([x, y]: [number,number]) => [x + 5, y + 5] as [number,number]), orig.style);
      else copy = makeText((orig as any).x + 5, (orig as any).y + 5, (orig as any).text, (orig as any).fontSize, (orig as any).fontFamily, orig.style);
      atlas.addShape(copy);
      selectedId = copy.id;
    }
  }

  // ---- edit helpers ----------------------------------------------------------
  function applyMove(id: string, orig: Shape, dx: number, dy: number, final: boolean): void {
    if (!final) {
      // Live preview without recording undo (undo will be recorded on final).
      const patch = movePatch(orig, dx, dy);
      atlas.shapes = atlas.shapes.map((s) => s.id === id ? { ...s, ...patch } as Shape : s);
      atlas.renderer?.setShapes(atlas.shapes);
    } else {
      atlas.updateShape(id, movePatch(orig, dx, dy));
    }
  }

  function movePatch(orig: Shape, dx: number, dy: number): Partial<Shape> {
    if (orig.kind === 'rect') return { x: (orig as any).x + dx, y: (orig as any).y + dy } as any;
    if (orig.kind === 'ellipse') return { cx: (orig as any).cx + dx, cy: (orig as any).cy + dy } as any;
    if (orig.kind === 'polygon' || orig.kind === 'freehand')
      return { vertices: (orig as any).vertices.map(([x, y]: [number,number]) => [x + dx, y + dy] as [number,number]) } as any;
    if (orig.kind === 'line' || orig.kind === 'arrow')
      return { points: (orig as any).points.map(([x, y]: [number,number]) => [x + dx, y + dy] as [number,number]) } as any;
    if (orig.kind === 'text') return { x: (orig as any).x + dx, y: (orig as any).y + dy } as any;
    return {};
  }

  function findShapeAt(wx: number, wy: number): Shape | null {
    if (!atlas.renderer) return null;
    const wpp = atlas.renderer.worldPerPixel();
    // Check in reverse order (topmost first).
    for (let i = atlas.shapes.length - 1; i >= 0; i--) {
      const s = atlas.shapes[i];
      if (isNearShape(wx, wy, s, wpp)) return s;
    }
    return null;
  }

  function isNearShape(wx: number, wy: number, s: Shape, wpp: number): boolean {
    const tol = 8 * wpp; // 8 CSS pixels in world units
    if (s.kind === 'rect') {
      const r = s as RectShape;
      return wx >= r.x - tol && wx <= r.x + r.w + tol && wy >= r.y - tol && wy <= r.y + r.h + tol;
    }
    if (s.kind === 'ellipse') {
      const e = s as EllipseShape;
      const nx = (wx - e.cx) / (e.rx + tol);
      const ny = (wy - e.cy) / (e.ry + tol);
      return nx * nx + ny * ny <= 1;
    }
    if (s.kind === 'polygon' || s.kind === 'freehand') {
      const verts = (s as any).vertices as [number,number][];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [vx, vy] of verts) {
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
      }
      return wx >= minX - tol && wx <= maxX + tol && wy >= minY - tol && wy <= maxY + tol;
    }
    if (s.kind === 'line' || s.kind === 'arrow') {
      const pts = (s as any).points as [number, number][];
      for (let i = 0; i + 1 < pts.length; i++) {
        if (distToSegment(wx, wy, pts[i], pts[i + 1]) <= tol) return true;
      }
      return false;
    }
    if (s.kind === 'text') {
      const t = s as any;
      return Math.hypot(wx - t.x, wy - t.y) <= tol * 4;
    }
    return false;
  }

  function distToSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function styleString(s: Shape): string {
    const c = s.style.strokeColor;
    return `rgba(${c[0]},${c[1]},${c[2]},${c[3]/255})`;
  }
  function fillString(s: Shape): string {
    const c = s.style.fillColor;
    return `rgba(${c[0]},${c[1]},${c[2]},${c[3]/255})`;
  }
  function strokeW(s: Shape): number {
    return s.style.strokeWidth;
  }

  // Expose drawMode setter so AnnotateTab can set the type.
  export function setDrawMode(mode: DrawMode) {
    drawMode = mode;
    selectedId = null;
    drawStart = null;
    drawCurrent = null;
    polyPoints = [];
    freePoints = [];
  }
  export function getSelectedId() { return selectedId; }
</script>

<svelte:window onkeydown={onKey} />

{#if active}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={el}
    class="shape-layer"
    class:drawing={drawMode !== 'idle'}
    role="application"
    aria-label="Shapes tool: draw and edit map shapes"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    ondblclick={onDblClick}
    onpointercancel={() => { drawStart = null; drawCurrent = null; freePoints = []; editMode = 'idle'; }}
  >
    <!-- Invisible background rect to capture pointer events on empty canvas area -->
    <rect x="0" y="0" width={svgW} height={svgH} fill="transparent" />

    <!-- Existing shapes -->
    {#each atlas.shapes as shape (shape.id)}
      {@const isSelected = shape.id === selectedId}
      {#if shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'polygon' || shape.kind === 'freehand'}
        <polygon
          points={shapeScreenPoly(shape)}
          fill={fillString(shape)}
          stroke={styleString(shape)}
          stroke-width={strokeW(shape)}
          stroke-dasharray={shape.style.dash?.join(',') || 'none'}
          opacity={shape.style.opacity}
          class:selected={isSelected}
        />
      {:else if shape.kind === 'line' || shape.kind === 'arrow'}
        <polyline
          points={shapeScreenLine(shape)}
          fill="none"
          stroke={styleString(shape)}
          stroke-width={strokeW(shape)}
          stroke-dasharray={shape.style.dash?.join(',') || 'none'}
          marker-end={shape.kind === 'arrow' ? `url(#arrow-${shape.id})` : ''}
          opacity={shape.style.opacity}
          class:selected={isSelected}
        />
        {#if shape.kind === 'arrow'}
          <defs>
            <marker id="arrow-{shape.id}" markerWidth="8" markerHeight="8" refX="4" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill={styleString(shape)} />
            </marker>
          </defs>
        {/if}
      {:else if shape.kind === 'text'}
        {@const s = screen((shape as any).x, (shape as any).y)}
        {#if s}
          <text x={s[0]} y={s[1]}
            font-size={(shape as any).fontSize ?? 14}
            font-family={(shape as any).fontFamily ?? 'sans-serif'}
            fill={styleString(shape)}
            opacity={shape.style.opacity}
            class:selected={isSelected}
          >{(shape as any).text}</text>
        {/if}
      {/if}

      <!-- Selection handles for selected shape -->
      {#if isSelected && (shape.kind === 'rect' || shape.kind === 'ellipse')}
        {#each handlePositions(shape) as hp, i}
          {#if hp}
            {#if i === (shape.kind === 'rect' ? 8 : 4)}
              <!-- Rotate handle -->
              <circle cx={hp[0]} cy={hp[1]} r="6" fill="rgba(255,200,0,0.9)" stroke="white" stroke-width="1.5" class="handle rotate-handle" />
            {:else}
              <!-- Resize handle -->
              <rect x={hp[0] - 4} y={hp[1] - 4} width="8" height="8"
                fill="white" stroke="rgba(0,120,255,0.9)" stroke-width="1.5"
                class="handle resize-handle"
              />
            {/if}
          {/if}
        {/each}
      {/if}
    {/each}

    <!-- In-progress drawing preview -->
    {#if (drawMode === 'draw-rect' || drawMode === 'draw-ellipse') && previewPoly}
      <polygon points={previewPoly}
        fill="rgba(255,80,80,0.1)"
        stroke="rgba(255,80,80,0.8)"
        stroke-width="1.5"
        stroke-dasharray="4 3"
      />
    {/if}
    {#if drawMode === 'draw-polygon' && previewPolyPoints}
      <polyline points={previewPolyPoints}
        fill="none"
        stroke="rgba(255,80,80,0.8)"
        stroke-width="1.5"
        stroke-dasharray="4 3"
      />
    {/if}
    {#if drawMode === 'draw-freehand' && previewFreehand}
      <polyline points={previewFreehand}
        fill="none"
        stroke="rgba(255,80,80,0.8)"
        stroke-width="1.5"
      />
    {/if}
    {#if (drawMode === 'draw-line' || drawMode === 'draw-arrow') && previewLine}
      <polyline points={previewLine}
        fill="none"
        stroke="rgba(255,80,80,0.8)"
        stroke-width="1.5"
        stroke-dasharray="4 3"
      />
    {/if}
  </svg>
{/if}

<style>
  .shape-layer {
    position: absolute;
    inset: 0;
    z-index: 9;
    width: 100%;
    height: 100%;
    pointer-events: all;
    user-select: none;
    overflow: visible;
  }
  .shape-layer.drawing {
    cursor: crosshair;
  }
  :global(.shape-layer polygon.selected),
  :global(.shape-layer polyline.selected),
  :global(.shape-layer text.selected) {
    outline: none;
    filter: drop-shadow(0 0 3px rgba(0,120,255,0.8));
  }
  .handle {
    cursor: pointer;
  }
  .resize-handle {
    cursor: nwse-resize;
  }
  .rotate-handle {
    cursor: grab;
  }
</style>
