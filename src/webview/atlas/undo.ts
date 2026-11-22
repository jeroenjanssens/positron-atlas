/**
 * Undo / redo wiring (plan item 6): records user edits in the Atlas's command stack.
 *
 * `history.ts` holds the generic stack; this module knows the Atlas state that edits change
 * (label offsets, hidden categories, the title overlay) and keeps the reactive
 * undo/redo labels in sync with the stack.
 */

import type { Atlas } from '../atlas.svelte';
import type { TitleOptions } from '../../shared/protocol';
import type { HistoryEntry } from './history';
import { setDragOffset, resetAllDragOffsets } from './labels';

type Offsets = Record<string, [number, number]>;

function syncLabels(atlas: Atlas): void {
  atlas.undoLabel = atlas.history.undoLabel;
  atlas.redoLabel = atlas.history.redoLabel;
}

export function recordHistory(atlas: Atlas, entry: HistoryEntry): void {
  atlas.history.record(entry);
  syncLabels(atlas);
}

export function undo(atlas: Atlas): void {
  atlas.history.undo();
  syncLabels(atlas);
}

export function redo(atlas: Atlas): void {
  atlas.history.redo();
  syncLabels(atlas);
}

/** Forget the history (a new frame or a reload). */
export function clearHistory(atlas: Atlas): void {
  atlas.history.clear();
  syncLabels(atlas);
}

// ---- label offsets -----------------------------------------------------------------

function applyOffsets(atlas: Atlas, offsets: Offsets): void {
  atlas.labels = { ...atlas.labels, dragOffsets: offsets };
  atlas.persist();
  atlas.updateLabels();
}

/** Run `change` on the label offsets and record the difference as one undo step. */
function changeOffsets(atlas: Atlas, label: string, change: () => void): void {
  const before: Offsets = { ...(atlas.labels.dragOffsets ?? {}) };
  change();
  const after: Offsets = { ...(atlas.labels.dragOffsets ?? {}) };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  recordHistory(atlas, {
    label,
    undo: () => applyOffsets(atlas, before),
    redo: () => applyOffsets(atlas, after),
  });
}

/** A label was dragged by `delta` (map units) on top of any earlier offset. */
export function moveLabel(atlas: Atlas, key: string, delta: [number, number]): void {
  changeOffsets(atlas, `Move label "${key}"`, () => {
    const [x, y] = atlas.labels.dragOffsets?.[key] ?? [0, 0];
    setDragOffset(atlas, key, [x + delta[0], y + delta[1]]);
  });
}

export function resetLabel(atlas: Atlas, key: string): void {
  changeOffsets(atlas, `Reset label "${key}"`, () => setDragOffset(atlas, key, null));
}

export function resetAllLabels(atlas: Atlas): void {
  changeOffsets(atlas, 'Reset all label positions', () => resetAllDragOffsets(atlas));
}

// ---- legend ------------------------------------------------------------------------

/** Run `change` on the hidden legend categories and record it as one undo step. */
export function changeHiddenCategories(atlas: Atlas, label: string, change: () => void): void {
  const before = new Map(atlas.hiddenCategories);
  change();
  const after = new Map(atlas.hiddenCategories);
  const apply = (m: typeof before) => {
    atlas.hiddenCategories = new Map(m);
    atlas.render();
  };
  recordHistory(atlas, { label, undo: () => apply(before), redo: () => apply(after) });
}

// ---- title overlay -----------------------------------------------------------------

const TITLE_FIELD_LABELS: Partial<Record<keyof TitleOptions, string>> = {
  title: 'Change title',
  subtitle: 'Change subtitle',
  logoData: 'Change logo',
  fontSize: 'Change title font size',
  fontFamily: 'Change title font',
  color: 'Change title colour',
  logoWidth: 'Change logo width',
};

/** Change the title overlay; typing in one field becomes one undo step (coalesced). */
export function setTitleOverlay(atlas: Atlas, partial: Partial<TitleOptions>): void {
  const before = { ...atlas.titleOverlay };
  atlas.titleOverlay = { ...atlas.titleOverlay, ...partial };
  const after = { ...atlas.titleOverlay };
  const field = (Object.keys(partial)[0] ?? 'title') as keyof TitleOptions;
  recordHistory(atlas, {
    label: TITLE_FIELD_LABELS[field] ?? 'Change title overlay',
    undo: () => { atlas.titleOverlay = before; },
    redo: () => { atlas.titleOverlay = after; },
    coalesceKey: `titleOverlay:${field}`,
  });
}
