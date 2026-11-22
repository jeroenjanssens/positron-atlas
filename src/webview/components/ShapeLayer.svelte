<script lang="ts">
  /**
   * ShapeLayer — pointer overlay for the shapes tool (B4, item 8).
   *
   * Handles:
   *  - Drawing new shapes (rect, ellipse, polygon, freehand, line, arrow, text)
   *  - Selecting and editing existing shapes (move, resize via 8 handles, rotate, delete)
   *  - Polygon/polyline vertex editing: drag vertex, dbl-click edge to insert, Alt-click to remove
   *  - Front/back order via keyboard ([ / ] when shapes tool active)
   *  - All edits are undoable via atlas.updateShape
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
  type EditMode = 'idle' | 'move' | 'resize' | 'rotate' | 'vertex';

  let drawMode = $state<DrawMode>('idle');
  let editMode = $state<EditMode>('idle');

  // In-progress shape drawing
  let drawStart = $state<[number, number] | null>(null);  // world coords
  let drawCurrent = $state<[number, number] | null>(null); // world coords
  let polyPoints = $state<[number, number][]>([]);
  let freePoints = $state<[number, number][]>([]);

  // Selection / editing
  let selectedId = $state<string | null>(null);
  let editHandle = $state<number>(-1);    // 0-7 = resize handles, 8 = rotate handle (rect); 0-3 resize, 4 rotate (ellipse); vertex index (polygon/line)
  let editStart = $state<[number, number] | null>(null);  // world
  let editOrigShape = $state<Shape | null>(null);
  let rotateStartAngle = $state(0);  // initial angle when rotate drag started

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

  // Keep atlas.shapesSelectedId in sync for dispatcher (front/back order keys)
  $effect(() => { atlas.shapesSelectedId = selectedId; });

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
      const angle = (e.rotation ?? 0) * Math.PI / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (let i = 0; i < segs; i++) {
        const t = (2 * Math.PI * i) / segs;
        const ex = e.rx * Math.cos(t);
        const ey = e.ry * Math.sin(t);
        const wx = e.cx + ex * cos - ey * sin;
        const wy = e.cy + ex * sin + ey * cos;
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

  // ---- edit handles: 8 resize + 1 rotate for rect; 4 resize + 1 rotate for ellipse ----
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
      // Local handle positions: in world space y increases upward, so +hh is the top of the shape.
      // Handle order: TL(0) T(1) TR(2) R(3) BR(4) B(5) BL(6) L(7) Rotate(8)
      // "Top" = higher y in world = top of shape on screen.
      const local: [number, number][] = [
        [-hw, hh], [0, hh], [hw, hh],  // 0,1,2: top-left, top-center, top-right
        [hw, 0],                          // 3: right-center
        [hw, -hh], [0, -hh], [-hw, -hh], // 4,5,6: bottom-right, bottom-center, bottom-left
        [-hw, 0],                         // 7: left-center
        [0, hh + 20 * (atlas.renderer.worldPerPixel() || 1)] // 8: rotate handle 20px above top
      ];
      return local.map(([dx, dy]) => screen(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos));
    }
    if (shape.kind === 'ellipse') {
      const e = shape as EllipseShape;
      const angle = (e.rotation ?? 0) * Math.PI / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // In world space y increases upward, so +ry is the top of the ellipse.
      const local: [number, number][] = [
        [-e.rx, 0],  // 0: left
        [0, e.ry],   // 1: top (positive y = up)
        [e.rx, 0],   // 2: right
        [0, -e.ry],  // 3: bottom
        [0, e.ry + 20 * (atlas.renderer.worldPerPixel() || 1)] // 4: rotate handle 20px above top
      ];
      return local.map(([dx, dy]) => screen(e.cx + dx * cos - dy * sin, e.cy + dx * sin + dy * cos));
    }
    return [];
  }

  // ---- resize math for rect -----------------------------------------------------
  function resizePatchRect(orig: RectShape, wx: number, wy: number, handle: number, shiftKey: boolean): Partial<RectShape> {
    const rot = (orig.rotation ?? 0) * Math.PI / 180;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const cx = orig.x + orig.w / 2, cy = orig.y + orig.h / 2;
    const hw = orig.w / 2, hh = orig.h / 2;

    // Convert world pointer to local (un-rotate around current center)
    const dx = wx - cx, dy = wy - cy;
    let lx = dx * cos + dy * sin;
    let ly = -dx * sin + dy * cos;

    // Handle layout (y+ = up in world): 0=TL(-hw,+hh) 1=T(0,+hh) 2=TR(+hw,+hh)
    //   3=R(+hw,0) 4=BR(+hw,-hh) 5=B(0,-hh) 6=BL(-hw,-hh) 7=L(-hw,0) 8=Rotate
    const isLeft  = handle === 0 || handle === 6 || handle === 7;
    const isRight = handle === 2 || handle === 3 || handle === 4;
    const isTop   = handle === 0 || handle === 1 || handle === 2;  // at local +hh
    const isBottom = handle === 4 || handle === 5 || handle === 6; // at local -hh

    // Pinned corner/edge in local coords (opposite to handle, anchored during resize)
    // Top handles at +hh → anchor is at -hh (bottom); bottom handles → anchor at +hh (top)
    const pLx = isLeft ? hw : (isRight ? -hw : 0);
    const pLy = isTop  ? -hh : (isBottom ? hh : 0);

    // For edge handles, constrain pointer to same x=0 or y=0 line in local
    if (!isLeft && !isRight) lx = 0;
    if (!isTop && !isBottom) ly = 0;

    // Pinned world position
    const pWx = cx + pLx * cos - pLy * sin;
    const pWy = cy + pLx * sin + pLy * cos;

    // Handle world position (from constrained local)
    const hWx = cx + lx * cos - ly * sin;
    const hWy = cy + lx * sin + ly * cos;

    // New center world = midpoint of pinned and handle
    const newCx = (pWx + hWx) / 2;
    const newCy = (pWy + hWy) / 2;

    // New dimensions from diff vector projected onto local axes
    const diffX = hWx - pWx, diffY = hWy - pWy;
    let newHw = (!isLeft && !isRight) ? hw : Math.max(0.001, Math.abs(diffX * cos + diffY * sin) / 2);
    let newHh = (!isTop && !isBottom) ? hh : Math.max(0.001, Math.abs(-diffX * sin + diffY * cos) / 2);

    // Shift = aspect ratio lock (corner handles only)
    if (shiftKey && (isLeft || isRight) && (isTop || isBottom)) {
      const aspect = hw / hh;
      if (newHw / newHh > aspect) newHh = newHw / aspect;
      else newHw = newHh * aspect;
    }

    return { x: newCx - newHw, y: newCy - newHh, w: newHw * 2, h: newHh * 2 };
  }

  // ---- resize math for ellipse -------------------------------------------------
  function resizePatchEllipse(orig: EllipseShape, wx: number, wy: number, handle: number, shiftKey: boolean): Partial<EllipseShape> {
    const rot = (orig.rotation ?? 0) * Math.PI / 180;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const dx = wx - orig.cx, dy = wy - orig.cy;
    // Local position of pointer
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;

    let newRx = orig.rx, newRy = orig.ry;
    if (handle === 0 || handle === 2) newRx = Math.max(0.001, Math.abs(lx));
    if (handle === 1 || handle === 3) newRy = Math.max(0.001, Math.abs(ly));

    if (shiftKey) {
      const aspect = orig.rx / orig.ry;
      if (handle === 0 || handle === 2) newRy = newRx / aspect;
      else newRx = newRy * aspect;
    }
    return { rx: newRx, ry: newRy };
  }

  // ---- rotate math -------------------------------------------------------------
  function rotatePatch(orig: RectShape | EllipseShape, wx: number, wy: number): { rotation: number } {
    const cx = orig.kind === 'rect' ? orig.x + orig.w / 2 : orig.cx;
    const cy = orig.kind === 'rect' ? orig.y + orig.h / 2 : orig.cy;
    const angle = Math.atan2(wy - cy, wx - cx) * 180 / Math.PI;
    const newRotation = ((angle - rotateStartAngle) % 360 + 360) % 360;
    return { rotation: newRotation };
  }

  // ---- pointer events ---------------------------------------------------------

  /** Called when a resize or rotate handle is pressed. Stops propagation so the SVG onDown doesn't also fire. */
  function onHandleDown(e: PointerEvent, handleIdx: number) {
    e.stopPropagation();
    if (e.button !== 0 || !atlas.renderer || !el || !selectedShape) return;
    if (selectedShape.kind !== 'rect' && selectedShape.kind !== 'ellipse') return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const [wx, wy] = world(e);
    editHandle = handleIdx;
    editStart = [wx, wy];
    editOrigShape = JSON.parse(JSON.stringify(selectedShape)) as Shape;

    const rotateIdx = selectedShape.kind === 'rect' ? 8 : 4;
    if (handleIdx === rotateIdx) {
      editMode = 'rotate';
      const cx = selectedShape.kind === 'rect' ? selectedShape.x + selectedShape.w / 2 : selectedShape.cx;
      const cy = selectedShape.kind === 'rect' ? selectedShape.y + selectedShape.h / 2 : selectedShape.cy;
      const currentRotation = (selectedShape as any).rotation ?? 0;
      rotateStartAngle = Math.atan2(wy - cy, wx - cx) * 180 / Math.PI - currentRotation;
    } else {
      editMode = 'resize';
    }
  }

  /** Called when a polygon/line vertex handle is pressed. */
  function onVertexDown(e: PointerEvent, vertexIdx: number) {
    e.stopPropagation();
    if (e.button !== 0 || !atlas.renderer || !el || !selectedShape) return;
    if (e.altKey) {
      // Alt-click: remove vertex (minimum 3 for polygon, 2 for line/arrow)
      removeVertex(vertexIdx);
      return;
    }
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const [wx, wy] = world(e);
    editHandle = vertexIdx;
    editStart = [wx, wy];
    editOrigShape = JSON.parse(JSON.stringify(selectedShape)) as Shape;
    editMode = 'vertex';
  }

  function removeVertex(vertexIdx: number) {
    if (!selectedShape || !selectedId) return;
    const minVerts = (selectedShape.kind === 'line' || selectedShape.kind === 'arrow') ? 2 : 3;
    const field = (selectedShape.kind === 'line' || selectedShape.kind === 'arrow') ? 'points' : 'vertices';
    const verts: [number, number][] = [...(selectedShape as any)[field]];
    if (verts.length <= minVerts) return;
    verts.splice(vertexIdx, 1);
    atlas.updateShape(selectedId, { [field]: verts } as any);
  }

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
        editOrigShape = JSON.parse(JSON.stringify(hit)) as Shape;
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
      // Live preview: update atlas.shapes directly without undo record
      const patch = movePatch(editOrigShape, dx, dy);
      atlas.shapes = atlas.shapes.map((s) => s.id === selectedId ? { ...s, ...patch } as Shape : s);
      atlas.renderer?.setShapes(atlas.shapes);
    }

    if (editMode === 'resize' && editOrigShape && selectedId) {
      const orig = editOrigShape;
      let patch: any;
      if (orig.kind === 'rect') {
        patch = resizePatchRect(orig as RectShape, wx, wy, editHandle, e.shiftKey);
      } else if (orig.kind === 'ellipse') {
        patch = resizePatchEllipse(orig as EllipseShape, wx, wy, editHandle, e.shiftKey);
      }
      if (patch) {
        // Live preview without undo record
        atlas.shapes = atlas.shapes.map((s) => s.id === selectedId ? { ...s, ...patch } as Shape : s);
        atlas.renderer?.setShapes(atlas.shapes);
      }
    }

    if (editMode === 'rotate' && editOrigShape && selectedId) {
      const orig = editOrigShape;
      if (orig.kind === 'rect' || orig.kind === 'ellipse') {
        const patch = rotatePatch(orig as RectShape | EllipseShape, wx, wy);
        atlas.shapes = atlas.shapes.map((s) => s.id === selectedId ? { ...s, ...patch } as Shape : s);
        atlas.renderer?.setShapes(atlas.shapes);
      }
    }

    if (editMode === 'vertex' && editOrigShape && selectedId) {
      const orig = editOrigShape;
      const field = (orig.kind === 'line' || orig.kind === 'arrow') ? 'points' : 'vertices';
      const verts: [number, number][] = [...(orig as any)[field]];
      verts[editHandle] = [wx, wy];
      atlas.shapes = atlas.shapes.map((s) => s.id === selectedId ? { ...s, [field]: verts } as Shape : s);
      atlas.renderer?.setShapes(atlas.shapes);
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
      // Use commitShapeEdit so undo correctly restores from editOrigShape, not the live-preview state
      atlas.commitShapeEdit(selectedId, editOrigShape, movePatch(editOrigShape, dx, dy));
      editMode = 'idle';
      editStart = null;
      editOrigShape = null;
    }

    if (editMode === 'resize' && editOrigShape && selectedId) {
      const orig = editOrigShape;
      let patch: any;
      if (orig.kind === 'rect') patch = resizePatchRect(orig as RectShape, wx, wy, editHandle, e.shiftKey);
      else if (orig.kind === 'ellipse') patch = resizePatchEllipse(orig as EllipseShape, wx, wy, editHandle, e.shiftKey);
      if (patch) atlas.commitShapeEdit(selectedId, orig, patch);
      editMode = 'idle';
      editStart = null;
      editOrigShape = null;
    }

    if (editMode === 'rotate' && editOrigShape && selectedId) {
      const orig = editOrigShape;
      if (orig.kind === 'rect' || orig.kind === 'ellipse') {
        atlas.commitShapeEdit(selectedId, orig, rotatePatch(orig as RectShape | EllipseShape, wx, wy));
      }
      editMode = 'idle';
      editStart = null;
      editOrigShape = null;
    }

    if (editMode === 'vertex' && editOrigShape && selectedId) {
      const orig = editOrigShape;
      const field = (orig.kind === 'line' || orig.kind === 'arrow') ? 'points' : 'vertices';
      const verts: [number, number][] = [...(orig as any)[field]];
      verts[editHandle] = [wx, wy];
      atlas.commitShapeEdit(selectedId, orig, { [field]: verts } as any);
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

    // Close polygon / line in drawing mode
    if (drawMode === 'draw-polygon' && polyPoints.length >= 3) {
      const shape = makePolygon([...polyPoints], currentStyle());
      atlas.addShape(shape);
      selectedId = shape.id;
      polyPoints = [];
      drawCurrent = null;
      return;
    }
    if ((drawMode === 'draw-line' || drawMode === 'draw-arrow') && polyPoints.length >= 2) {
      const shape = drawMode === 'draw-arrow'
        ? makeArrow([...polyPoints], currentStyle())
        : makeLine([...polyPoints], currentStyle());
      atlas.addShape(shape);
      selectedId = shape.id;
      polyPoints = [];
      drawCurrent = null;
      return;
    }

    // Insert vertex on edge of selected polygon/line/arrow
    if (selectedShape && (selectedShape.kind === 'polygon' || selectedShape.kind === 'freehand' ||
        selectedShape.kind === 'line' || selectedShape.kind === 'arrow') && selectedId) {
      const field = (selectedShape.kind === 'line' || selectedShape.kind === 'arrow') ? 'points' : 'vertices';
      const verts: [number, number][] = (selectedShape as any)[field];
      const wpp = atlas.renderer.worldPerPixel();
      const tol = 10 * wpp;
      let bestEdge = -1, bestDist = Infinity;
      for (let i = 0; i < verts.length - 1; i++) {
        const d = distToSegment(wx, wy, verts[i], verts[i + 1]);
        if (d < tol && d < bestDist) { bestDist = d; bestEdge = i; }
      }
      // For closed shapes, also check the edge from last to first
      if (selectedShape.kind === 'polygon' || selectedShape.kind === 'freehand') {
        const d = distToSegment(wx, wy, verts[verts.length - 1], verts[0]);
        if (d < tol && d < bestDist) { bestDist = d; bestEdge = verts.length - 1; }
      }
      if (bestEdge >= 0) {
        const newVerts = [...verts.slice(0, bestEdge + 1), [wx, wy] as [number, number], ...verts.slice(bestEdge + 1)];
        atlas.updateShape(selectedId, { [field]: newVerts } as any);
      }
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
      drawMode = 'idle';
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
        {@const ah = shape.style.arrowHead ?? (shape.kind === 'arrow' ? 'end' : 'none')}
        <polyline
          points={shapeScreenLine(shape)}
          fill="none"
          stroke={styleString(shape)}
          stroke-width={strokeW(shape)}
          stroke-dasharray={shape.style.dash?.join(',') || 'none'}
          marker-end={ah === 'end' || ah === 'both' ? `url(#arrowend-${shape.id})` : ''}
          marker-start={ah === 'start' || ah === 'both' ? `url(#arrowstart-${shape.id})` : ''}
          opacity={shape.style.opacity}
          class:selected={isSelected}
        />
        {#if ah !== 'none'}
          <defs>
            {#if ah === 'end' || ah === 'both'}
              <marker id="arrowend-{shape.id}" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill={styleString(shape)} />
              </marker>
            {/if}
            {#if ah === 'start' || ah === 'both'}
              <marker id="arrowstart-{shape.id}" markerWidth="8" markerHeight="8" refX="1" refY="3" orient="auto-start-reverse">
                <path d="M0,0 L0,6 L8,3 z" fill={styleString(shape)} />
              </marker>
            {/if}
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

      <!-- Resize and rotate handles for selected rect/ellipse -->
      {#if isSelected && (shape.kind === 'rect' || shape.kind === 'ellipse')}
        {#each handlePositions(shape) as hp, i}
          {#if hp}
            {#if i === (shape.kind === 'rect' ? 8 : 4)}
              <!-- Rotate handle -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <circle cx={hp[0]} cy={hp[1]} r="6" fill="rgba(255,200,0,0.9)" stroke="white" stroke-width="1.5"
                class="handle rotate-handle"
                onpointerdown={(e) => onHandleDown(e, i)}
              />
            {:else}
              <!-- Resize handle -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <rect x={hp[0] - 4} y={hp[1] - 4} width="8" height="8"
                fill="white" stroke="rgba(0,120,255,0.9)" stroke-width="1.5"
                class="handle resize-handle"
                onpointerdown={(e) => onHandleDown(e, i)}
              />
            {/if}
          {/if}
        {/each}
      {/if}

      <!-- Vertex handles for selected polygon/polyline -->
      {#if isSelected && (shape.kind === 'polygon' || shape.kind === 'freehand' || shape.kind === 'line' || shape.kind === 'arrow')}
        {@const verts = shape.kind === 'polygon' || shape.kind === 'freehand' ? (shape as any).vertices : (shape as any).points}
        {#each verts as v, i}
          {@const sp = screen(v[0], v[1])}
          {#if sp}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <circle cx={sp[0]} cy={sp[1]} r="5"
              fill="rgba(0,120,255,0.8)" stroke="white" stroke-width="1.5"
              class="handle vertex-handle"
              onpointerdown={(e) => onVertexDown(e, i)}
            />
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
  .vertex-handle {
    cursor: move;
  }
</style>
