/**
 * Undo/redo command stack (plan item 6, wave A3).
 *
 * Session-only: not persisted to panel state.  The stack has at most
 * MAX_HISTORY entries; the oldest entry is dropped when the limit is reached.
 *
 * Coalescing: when record() is called with a coalesceKey that matches the
 * top entry's coalesceKey, the two entries are merged — the original undo
 * closure is kept and only the redo closure (and label) are updated.
 * This turns a continuous drag (many mousemove events) or rapid keystroke
 * sequence into a single undo step.
 */

export interface HistoryEntry {
  /** Short description shown in the button tooltip, e.g. 'move label "Cluster 3"'. */
  label: string;
  undo(): void;
  redo(): void;
  /**
   * Optional coalesce key.  Consecutive entries sharing the same key are
   * merged (keeps first undo, latest redo/label).  Use for continuous drags
   * and rapid text-input changes on the same field.
   */
  coalesceKey?: string;
}

export const MAX_HISTORY = 200;

export class CommandStack {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string { return this.past.at(-1)?.label ?? ''; }
  get redoLabel(): string { return this.future.at(-1)?.label ?? ''; }

  /**
   * Record a new entry.  Clears the redo stack unless coalescing with the
   * previous entry (same coalesceKey).
   */
  record(entry: HistoryEntry): void {
    const last = this.past.at(-1);
    if (entry.coalesceKey !== undefined && last?.coalesceKey === entry.coalesceKey) {
      // Merge: keep the original undo closure, update redo and label.
      this.past[this.past.length - 1] = {
        label: entry.label,
        undo: last.undo,
        redo: entry.redo,
        coalesceKey: entry.coalesceKey,
      };
    } else {
      if (this.past.length >= MAX_HISTORY) this.past.shift();
      this.past.push(entry);
      this.future = [];
    }
  }

  /** Apply undo. Returns true when there was something to undo. */
  undo(): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    entry.undo();
    this.future.push(entry);
    return true;
  }

  /** Apply redo. Returns true when there was something to redo. */
  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    entry.redo();
    this.past.push(entry);
    return true;
  }

  /** Discard the entire history (called on atlas reload). */
  clear(): void {
    this.past = [];
    this.future = [];
  }
}
