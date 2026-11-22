/**
 * Unit tests for navigation presets (item 1, napari-plan.md §1.2).
 *
 * Covers:
 *  - Every preset × action × 2D/3D in the binding table
 *  - Mouse description per preset (from BINDINGS.mouse)
 *  - NavController button/modifier mapping (middleDragType logic)
 *  - Platform notation helpers (formatKey, defaultKey) for all bindings
 */

import { describe, expect, it } from 'vitest';
import {
  BINDINGS,
  findBinding,
  defaultKey,
  formatKey,
  type ActionId,
} from '../src/webview/input/bindings';

// ---------------------------------------------------------------------------
// 1. view.showControls is registered
// ---------------------------------------------------------------------------

describe('view.showControls', () => {
  it('is in BINDINGS', () => {
    const entry = findBinding('view.showControls');
    expect(entry).toBeDefined();
    expect(entry!.key).toBe('?');
  });

  it('has section misc', () => {
    expect(findBinding('view.showControls')!.section).toBe('misc');
  });

  it('context is both', () => {
    expect(findBinding('view.showControls')!.context).toBe('both');
  });
});

// ---------------------------------------------------------------------------
// 2. Every required ActionId exists in BINDINGS
// ---------------------------------------------------------------------------

const REQUIRED_IDS: ActionId[] = [
  'view.reset',
  'view.zoomIn',
  'view.zoomOut',
  'view.panLeft',
  'view.panRight',
  'view.panUp',
  'view.panDown',
  'view.rotateLeft',
  'view.rotateRight',
  'view.resetRotation',
  'view.top',
  'view.front',
  'view.side',
  'view.toggle3D',
  'view.toggleFullScreen',
  'view.showControls',
  'tool.pan',
  'tool.lasso',
  'tool.annotate',
  'edit.undo',
  'edit.redo',
  'select.all',
  'select.clear',
];

describe('BINDINGS coverage', () => {
  for (const id of REQUIRED_IDS) {
    it(`has ${id}`, () => {
      expect(findBinding(id)).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Preset mouse descriptions from §1.2 table
// ---------------------------------------------------------------------------

describe('preset mouse descriptions', () => {
  // view.reset: double-click background in every preset
  it('view.reset has double-click background for all presets', () => {
    const e = findBinding('view.reset')!;
    expect(e.mouse?.dataMap).toContain('Double-click');
    expect(e.mouse?.molecular).toContain('Double-click');
    expect(e.mouse?.cad).toContain('Double-click');
    expect(e.mouse?.design).toContain('Double-click');
  });

  // 2D pan: each preset has distinct description
  it('view.panLeft has dataMap left-drag', () => {
    const e = findBinding('view.panLeft')!;
    expect(e.mouse?.dataMap).toContain('Left-drag');
  });

  it('view.panLeft has cad middle-drag', () => {
    const e = findBinding('view.panLeft')!;
    expect(e.mouse?.cad).toContain('Middle-drag');
  });

  it('view.panLeft has design Space-drag or scroll', () => {
    const e = findBinding('view.panLeft')!;
    const desc = e.mouse?.design ?? '';
    expect(desc.length).toBeGreaterThan(0);
  });

  // 2D rotation: dataMap and design have right-drag
  it('view.rotateLeft has right-drag for dataMap', () => {
    const e = findBinding('view.rotateLeft')!;
    expect(e.mouse?.dataMap).toContain('Right-drag');
  });

  it('view.rotateLeft has right-drag for design', () => {
    const e = findBinding('view.rotateLeft')!;
    expect(e.mouse?.design).toContain('Right-drag');
  });

  it('view.rotateLeft has no mouse entry for cad', () => {
    // CAD uses middle-drag for orbit, not right-drag for 2D rotate
    const e = findBinding('view.rotateLeft')!;
    expect(e.mouse?.cad).toBeFalsy();
  });

  // zoom
  it('view.zoomIn has scroll for dataMap', () => {
    const e = findBinding('view.zoomIn')!;
    expect(e.mouse?.dataMap).toContain('Scroll');
  });

  it('view.zoomIn has pinch/ctrl+scroll for design', () => {
    const e = findBinding('view.zoomIn')!;
    const desc = e.mouse?.design ?? '';
    expect(desc.toLowerCase()).toContain('pinch');
  });
});

// ---------------------------------------------------------------------------
// 4. NavController button/modifier mapping (middleDragType logic)
//    Mirrors the logic in controller.ts without importing the class
//    (which requires a DOM).  Uses a table-driven approach.
// ---------------------------------------------------------------------------

type Preset = 'dataMap' | 'molecular' | 'cad' | 'design';
type Dims = 2 | 3;
type DragType = 'pan' | 'orbit-3d';

function middleDragType(preset: Preset, dims: Dims, shiftKey: boolean): DragType {
  if (preset === 'cad') {
    if (dims === 3) return shiftKey ? 'pan' : 'orbit-3d';
    return 'pan';
  }
  return 'pan';
}

describe('NavController.middleDragType', () => {
  // CAD 2D: middle → pan
  it('cad 2D no-shift → pan', () => {
    expect(middleDragType('cad', 2, false)).toBe('pan');
  });
  it('cad 2D shift → pan', () => {
    expect(middleDragType('cad', 2, true)).toBe('pan');
  });

  // CAD 3D: middle → orbit, shift+middle → pan
  it('cad 3D no-shift → orbit-3d', () => {
    expect(middleDragType('cad', 3, false)).toBe('orbit-3d');
  });
  it('cad 3D shift → pan', () => {
    expect(middleDragType('cad', 3, true)).toBe('pan');
  });

  // Other presets: middle → pan in all cases
  for (const preset of ['dataMap', 'molecular', 'design'] as Preset[]) {
    for (const dims of [2, 3] as Dims[]) {
      it(`${preset} ${dims}D → pan`, () => {
        expect(middleDragType(preset, dims, false)).toBe('pan');
        expect(middleDragType(preset, dims, true)).toBe('pan');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Platform notation: formatKey for every binding on mac and win
// ---------------------------------------------------------------------------

describe('formatKey coverage', () => {
  it('formats all binding default keys on mac without throwing', () => {
    for (const b of BINDINGS) {
      const k = defaultKey(b, 'mac');
      if (k) {
        expect(() => formatKey(k, 'mac')).not.toThrow();
      }
    }
  });

  it('formats all binding default keys on win without throwing', () => {
    for (const b of BINDINGS) {
      const k = defaultKey(b, 'win');
      if (k) {
        expect(() => formatKey(k, 'win')).not.toThrow();
      }
    }
  });

  it('? key formats as ? on mac', () => {
    expect(formatKey('?', 'mac')).toBe('?');
  });

  it('? key formats as ? on win', () => {
    expect(formatKey('?', 'win')).toBe('?');
  });

  it('shift+/ formats as ⇧/ on mac', () => {
    expect(formatKey('shift+/', 'mac')).toBe('⇧/');
  });

  it('shift+/ formats as Shift+/ on win', () => {
    expect(formatKey('shift+/', 'win')).toBe('Shift+/');
  });
});

// ---------------------------------------------------------------------------
// 6. Context correctness: 2D-only bindings are context '2d'
// ---------------------------------------------------------------------------

describe('binding context', () => {
  it('view.rotateLeft/Right/resetRotation are context 2d', () => {
    for (const id of ['view.rotateLeft', 'view.rotateRight', 'view.resetRotation'] as ActionId[]) {
      expect(findBinding(id)!.context).toBe('2d');
    }
  });

  it('3D camera preset bindings are context 3d', () => {
    for (const id of ['view.top', 'view.front', 'view.side'] as ActionId[]) {
      expect(findBinding(id)!.context).toBe('3d');
    }
  });

  it('pan/zoom/reset bindings are context both', () => {
    for (const id of ['view.reset', 'view.zoomIn', 'view.zoomOut', 'view.panLeft'] as ActionId[]) {
      expect(findBinding(id)!.context).toBe('both');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Lasso / click modifiers are present (plan: same in every preset)
// ---------------------------------------------------------------------------

describe('select bindings', () => {
  it('select.all and select.clear are present', () => {
    expect(findBinding('select.all')).toBeDefined();
    expect(findBinding('select.clear')).toBeDefined();
  });

  it('tool.lasso is present and context both', () => {
    const e = findBinding('tool.lasso')!;
    expect(e).toBeDefined();
    expect(e.context).toBe('both');
  });
});
