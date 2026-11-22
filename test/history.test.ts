import { describe, expect, it } from 'vitest';
import { CommandStack, MAX_HISTORY } from '../src/webview/atlas/history';

function makeEntry(label: string, undo: () => void, redo: () => void, coalesceKey?: string) {
  return { label, undo, redo, coalesceKey };
}

describe('CommandStack', () => {
  it('starts empty with no undo/redo available', () => {
    const s = new CommandStack();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.undoLabel).toBe('');
    expect(s.redoLabel).toBe('');
  });

  it('record enables undo and clears redo', () => {
    const s = new CommandStack();
    const log: string[] = [];
    s.record(makeEntry('step 1', () => log.push('u1'), () => log.push('r1')));
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.undoLabel).toBe('step 1');
  });

  it('undo calls the undo closure and enables redo', () => {
    const s = new CommandStack();
    const log: string[] = [];
    s.record(makeEntry('step 1', () => log.push('u1'), () => log.push('r1')));
    s.undo();
    expect(log).toEqual(['u1']);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
    expect(s.redoLabel).toBe('step 1');
  });

  it('redo calls the redo closure and re-enables undo', () => {
    const s = new CommandStack();
    const log: string[] = [];
    s.record(makeEntry('step 1', () => log.push('u1'), () => log.push('r1')));
    s.undo();
    s.redo();
    expect(log).toEqual(['u1', 'r1']);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
  });

  it('records multiple entries in order and undoes them lifo', () => {
    const s = new CommandStack();
    const applied: string[] = [];
    s.record(makeEntry('a', () => applied.push('ua'), () => applied.push('ra')));
    s.record(makeEntry('b', () => applied.push('ub'), () => applied.push('rb')));
    s.record(makeEntry('c', () => applied.push('uc'), () => applied.push('rc')));
    expect(s.undoLabel).toBe('c');
    s.undo();
    expect(applied).toEqual(['uc']);
    expect(s.undoLabel).toBe('b');
    s.undo();
    expect(applied).toEqual(['uc', 'ub']);
    s.undo();
    expect(applied).toEqual(['uc', 'ub', 'ua']);
    expect(s.canUndo).toBe(false);
  });

  it('new record clears redo stack', () => {
    const s = new CommandStack();
    const log: string[] = [];
    s.record(makeEntry('a', () => log.push('ua'), () => log.push('ra')));
    s.record(makeEntry('b', () => log.push('ub'), () => log.push('rb')));
    s.undo(); // undo b
    expect(s.canRedo).toBe(true);
    s.record(makeEntry('c', () => log.push('uc'), () => log.push('rc'))); // new edit
    expect(s.canRedo).toBe(false); // redo cleared
    expect(s.undoLabel).toBe('c');
  });

  it('coalescing: consecutive same-key entries merge', () => {
    const s = new CommandStack();
    let state = 0;
    // Simulate dragging: position moves from 0 → 1 → 2 → 3
    for (let i = 1; i <= 3; i++) {
      const after = i;
      const before = 0; // always the original
      s.record(makeEntry(`drag to ${after}`, () => { state = before; }, () => { state = after; }, 'drag:label'));
    }
    // Should still be one entry in the past
    expect(s.canUndo).toBe(true);
    expect(s.undoLabel).toBe('drag to 3');
    // Redo: apply redo should set state to 3
    s.undo();
    expect(state).toBe(0); // undo restores original (before=0)
    s.redo();
    expect(state).toBe(3); // redo applies latest redo (after=3)
  });

  it('different coalesceKeys do not merge', () => {
    const s = new CommandStack();
    s.record(makeEntry('a', () => {}, () => {}, 'drag:a'));
    s.record(makeEntry('b', () => {}, () => {}, 'drag:b'));
    // Two separate past entries
    s.undo(); // undo b
    s.undo(); // undo a
    expect(s.canUndo).toBe(false);
  });

  it('coalescing stops when a non-coalesced entry is inserted', () => {
    const s = new CommandStack();
    s.record(makeEntry('drag 1', () => {}, () => {}, 'drag:x'));
    s.record(makeEntry('other', () => {}, () => {})); // breaks coalesce chain
    s.record(makeEntry('drag 2', () => {}, () => {}, 'drag:x')); // new chain
    // Now there should be 3 entries
    s.undo(); s.undo(); s.undo();
    expect(s.canUndo).toBe(false);
  });

  it('enforces MAX_HISTORY limit', () => {
    const s = new CommandStack();
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      s.record(makeEntry(`step ${i}`, () => {}, () => {}));
    }
    // The past should have at most MAX_HISTORY entries
    // We verify by undoing MAX_HISTORY times and checking nothing more is left
    let count = 0;
    while (s.canUndo) {
      s.undo();
      count++;
    }
    expect(count).toBe(MAX_HISTORY);
  });

  it('clear resets both stacks', () => {
    const s = new CommandStack();
    s.record(makeEntry('a', () => {}, () => {}));
    s.record(makeEntry('b', () => {}, () => {}));
    s.undo();
    s.clear();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
  });

  it('undo returns false when nothing to undo', () => {
    const s = new CommandStack();
    expect(s.undo()).toBe(false);
  });

  it('redo returns false when nothing to redo', () => {
    const s = new CommandStack();
    expect(s.redo()).toBe(false);
  });

  it('redo cleared label is "" when nothing to redo', () => {
    const s = new CommandStack();
    s.record(makeEntry('a', () => {}, () => {}));
    expect(s.redoLabel).toBe('');
    s.undo();
    expect(s.redoLabel).toBe('a');
    s.redo();
    expect(s.redoLabel).toBe('');
  });
});
