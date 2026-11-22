/**
 * Input dispatcher — routes keyboard events to Atlas actions.
 *
 * Responsibilities:
 *  - In Positron (VS Code webview): all keyboard shortcuts arrive via
 *    ToWebview { type: 'command' } forwarded by the VS Code keybinding machinery.
 *    No window keyboard listener is registered — avoids double-dispatch.
 *  - In a plain browser (harness, development): a window-level keyboard listener
 *    is registered so shortcuts work without VS Code.
 *  - Routes keys to atlas methods based on 2D/3D mode.
 *  - Does NOT intercept pointer/wheel events (handled by the deck.gl controller
 *    and by LassoLayer for the lasso overlay).
 *
 * Key policy (browser-only listener):
 *  - Skip when an input, select, or textarea has focus (the user is typing).
 *  - Skip modifier-only keys (Shift, Alt, Ctrl, Meta on their own).
 *  - ctrl+z / ctrl+shift+z handled before the modifier guard.
 *
 * Usage:
 *   const d = new InputDispatcher(atlas);
 *   // call d.destroy() when the Atlas instance is torn down.
 */

import type { Atlas } from '../atlas.svelte';
import { isVsCodeWebview } from '../vscode';
import type { ActionId } from './bindings';

/** How many world units to pan per key press (at current zoom). */
const KEY_PAN_FRACTION = 0.2;
/** Rotation step in degrees for [ and ] keys. */
const KEY_ROTATE_STEP = 15;
/** Zoom step per key press (deck.gl zoom levels). */
const KEY_ZOOM_STEP = 0.5;

/** True when the event target is an interactive text element (suppress navigation keys). */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (t.isContentEditable) return true;
  return false;
}

export class InputDispatcher {
  private readonly atlas: Atlas;
  private readonly onKey: ((e: KeyboardEvent) => void) | null;

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    if (isVsCodeWebview) {
      // In Positron: VS Code keybindings send { type: 'command' } messages; no listener needed.
      this.onKey = null;
    } else {
      // In browser/harness: handle keys directly (no VS Code keybinding machinery).
      this.onKey = (e) => this.handleKey(e);
      window.addEventListener('keydown', this.onKey);
    }
  }

  destroy(): void {
    if (this.onKey) {
      window.removeEventListener('keydown', this.onKey);
    }
  }

  /**
   * Execute an action by its action id.
   * Called both from the keyboard handler and from the host's 'command' message.
   */
  dispatch(actionId: ActionId): void {
    const a = this.atlas;
    switch (actionId) {
      // ---- View -------------------------------------------------------------------
      case 'view.reset':
        a.fitView();
        break;
      case 'view.zoomIn':
        a.renderer?.adjustZoom(KEY_ZOOM_STEP);
        break;
      case 'view.zoomOut':
        a.renderer?.adjustZoom(-KEY_ZOOM_STEP);
        break;
      case 'view.panLeft':
        a.renderer?.panByFraction(-KEY_PAN_FRACTION, 0);
        break;
      case 'view.panRight':
        a.renderer?.panByFraction(KEY_PAN_FRACTION, 0);
        break;
      case 'view.panUp':
        a.renderer?.panByFraction(0, -KEY_PAN_FRACTION);
        break;
      case 'view.panDown':
        a.renderer?.panByFraction(0, KEY_PAN_FRACTION);
        break;
      // ---- 2D rotation ------------------------------------------------------------
      case 'view.rotateLeft':
        if (a.dims === 2) {
          a.renderer?.adjustRotation2D(-KEY_ROTATE_STEP);
          a.rotation2D = a.renderer?.getRotation2D() ?? 0;
        }
        break;
      case 'view.rotateRight':
        if (a.dims === 2) {
          a.renderer?.adjustRotation2D(KEY_ROTATE_STEP);
          a.rotation2D = a.renderer?.getRotation2D() ?? 0;
        }
        break;
      case 'view.resetRotation':
        if (a.dims === 2) {
          a.renderer?.setRotation2D(0);
          a.rotation2D = 0;
        }
        break;
      // ---- 3D camera presets -----------------------------------------------------
      case 'view.top':
        if (a.dims === 3) a.setCameraPreset('top');
        break;
      case 'view.front':
        if (a.dims === 3) a.setCameraPreset('front');
        break;
      case 'view.side':
        if (a.dims === 3) a.setCameraPreset('side');
        break;
      // ---- Tools ------------------------------------------------------------------
      case 'tool.pan':
        a.tool = 'pan';
        break;
      case 'tool.lasso':
        a.tool = a.tool === 'lasso' ? 'pan' : 'lasso';
        break;
      case 'tool.annotate':
        if (a.dims !== 3) a.tool = a.tool === 'annotate' ? 'pan' : 'annotate';
        break;
      // ---- Select -----------------------------------------------------------------
      case 'select.all':
        // Select all visible points (creates a mask of all ones)
        if (a.prepared && a.prepared.nKept > 0) {
          const mask = new Uint8Array(Math.ceil(a.prepared.nKept / 8));
          mask.fill(0xff);
          a.setSelection(mask);
        }
        break;
      case 'select.clear':
        a.clearSelection();
        break;
      // ---- Misc -------------------------------------------------------------------
      case 'view.toggleFullScreen':
        a.toggleFullscreen();
        break;
      case 'view.toggle3D':
        a.setDims(a.dims === 2 ? 3 : 2);
        break;
      case 'view.showControls':
        a.cheatSheetVisible = !a.cheatSheetVisible;
        break;
      case 'edit.undo':
        a.undo();
        break;
      case 'edit.redo':
        a.redo();
        break;
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (isTyping(e)) return;
    // Don't fire on modifier-only presses.
    if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') return;

    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;

    // undo/redo need modifiers; skip if no modifier or non-matching combo.
    if (ctrl && key === 'z' && !shift) {
      this.dispatch('edit.undo');
      e.preventDefault();
      return;
    }
    if (ctrl && key === 'z' && shift) {
      this.dispatch('edit.redo');
      e.preventDefault();
      return;
    }

    // All navigation keys below are plain (no modifier) or we check explicitly.
    // Skip modifier combos we don't handle (let other handlers run).
    if (ctrl || alt) return;

    switch (key) {
      case 'r':
        if (!shift) { this.dispatch('view.reset'); e.preventDefault(); }
        break;
      case 'f':
        if (!shift) { this.dispatch('view.reset'); e.preventDefault(); }
        break;
      case 'home':
        if (!shift) { this.dispatch('view.reset'); e.preventDefault(); }
        break;
      case '+':
      case '=':
        this.dispatch('view.zoomIn');
        e.preventDefault();
        break;
      case '-':
        this.dispatch('view.zoomOut');
        e.preventDefault();
        break;
      case 'arrowleft':
        this.dispatch('view.panLeft');
        e.preventDefault();
        break;
      case 'arrowright':
        this.dispatch('view.panRight');
        e.preventDefault();
        break;
      case 'arrowup':
        this.dispatch('view.panUp');
        e.preventDefault();
        break;
      case 'arrowdown':
        this.dispatch('view.panDown');
        e.preventDefault();
        break;
      case '[':
        // [ rotates counter-clockwise in 2D.
        // In brush mode (B4) this will change brush size instead — handled by context.
        this.dispatch('view.rotateLeft');
        e.preventDefault();
        break;
      case ']':
        // ] rotates clockwise in 2D.
        this.dispatch('view.rotateRight');
        e.preventDefault();
        break;
      case 'n':
        this.dispatch('view.resetRotation');
        e.preventDefault();
        break;
      case '?':
        this.dispatch('view.showControls');
        e.preventDefault();
        break;
      case '1':
        if (shift) {
          this.dispatch('view.reset'); e.preventDefault();
        } else if (this.atlas.dims === 3) {
          this.dispatch('view.top'); e.preventDefault();
        }
        break;
      case '2':
        if (!shift && this.atlas.dims === 3) {
          this.dispatch('view.front'); e.preventDefault();
        }
        break;
      case '3':
        if (!shift && this.atlas.dims === 3) {
          this.dispatch('view.side'); e.preventDefault();
        }
        break;
      case 'numpad7':
        if (this.atlas.dims === 3) { this.dispatch('view.top'); e.preventDefault(); }
        break;
      case 'numpad1':
        if (this.atlas.dims === 3) { this.dispatch('view.front'); e.preventDefault(); }
        break;
      case 'numpad3':
        if (this.atlas.dims === 3) { this.dispatch('view.side'); e.preventDefault(); }
        break;
    }
  }
}
