/**
 * Binding registry — the single source of truth for navigation actions.
 *
 * Both the input dispatcher (what fires when a key is pressed) and the controls
 * cheat sheet (B1, wave B) read from this table.  Changing it here updates both.
 *
 * Layout:
 *   actionId   – unique stable string, matches the VS Code command suffix
 *   label      – human-readable name shown in the cheat sheet
 *   mouse      – per-preset mouse / gesture description (null = not bound for that preset)
 *   key        – default keyboard binding; platform variants use mac / win
 *   context    – when the binding is available ('2d', '3d', 'both', '2d-brush' etc.)
 */

/** All action identifiers that the dispatcher knows about. */
export type ActionId =
  | 'view.reset'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.panLeft'
  | 'view.panRight'
  | 'view.panUp'
  | 'view.panDown'
  | 'view.top'
  | 'view.front'
  | 'view.side'
  | 'view.toggle3D'
  | 'view.toggleFullScreen'
  | 'view.rotateLeft'
  | 'view.rotateRight'
  | 'view.resetRotation'
  | 'view.showControls'
  | 'tool.pan'
  | 'tool.lasso'
  | 'tool.annotate'
  | 'edit.undo'
  | 'edit.redo'
  | 'select.all'
  | 'select.clear';

/** Which contexts a binding applies in. */
export type BindingContext = '2d' | '3d' | 'both' | '2d-brush';

/**
 * Per-preset mouse / gesture description.
 * Key order: dataMap | molecular | cad | design.
 */
export type PresetMouse = {
  dataMap?: string;
  molecular?: string;
  cad?: string;
  design?: string;
};

/** One entry in the binding registry. */
export interface BindingEntry {
  /** Stable action id — also used as the VS Code command suffix. */
  actionId: ActionId;
  /** Human-readable label for the cheat sheet and UI. */
  label: string;
  /**
   * Mouse / gesture description per preset (null if not available for that preset).
   * Used by B1 cheat sheet.
   */
  mouse?: PresetMouse;
  /**
   * Default keyboard shortcut.
   * When only `key` is set it applies on all platforms.
   * Use `mac` / `win` for platform-specific defaults.
   */
  key?: string;
  mac?: string;
  win?: string;
  /** Section in the cheat sheet ('navigate' | 'select' | 'annotate' | 'view' | 'misc'). */
  section: 'navigate' | 'select' | 'annotate' | 'view' | 'misc';
  /** When this binding is active. */
  context: BindingContext;
  /** Presets for which this binding is offered (undefined = all presets). */
  preset?: string[];
}

/** All navigation bindings — one source of truth for dispatcher + cheat sheet. */
export const BINDINGS: BindingEntry[] = [
  // ---- Navigate: view reset / fit ------------------------------------------------
  {
    actionId: 'view.reset',
    label: 'Fit to view',
    mouse: {
      dataMap: 'Double-click background',
      molecular: 'Double-click background',
      cad: 'Double-click background',
      design: 'Double-click background',
    },
    key: 'r',
    section: 'navigate',
    context: 'both',
  },
  // ---- Navigate: zoom ------------------------------------------------------------
  {
    actionId: 'view.zoomIn',
    label: 'Zoom in',
    mouse: {
      dataMap: 'Scroll up',
      molecular: 'Scroll up',
      cad: 'Scroll up',
      design: 'Pinch / Ctrl+scroll',
    },
    key: '+',
    section: 'navigate',
    context: 'both',
  },
  {
    actionId: 'view.zoomOut',
    label: 'Zoom out',
    mouse: {
      dataMap: 'Scroll down',
      molecular: 'Scroll down',
      cad: 'Scroll down',
      design: 'Pinch / Ctrl+scroll',
    },
    key: '-',
    section: 'navigate',
    context: 'both',
  },
  // ---- Navigate: pan -------------------------------------------------------------
  {
    actionId: 'view.panLeft',
    label: 'Pan left',
    mouse: {
      dataMap: 'Left-drag',
      molecular: 'Left-drag',
      cad: 'Middle-drag',
      design: 'Space-drag / two-finger scroll',
    },
    key: 'arrowleft',
    section: 'navigate',
    context: 'both',
  },
  {
    actionId: 'view.panRight',
    label: 'Pan right',
    key: 'arrowright',
    section: 'navigate',
    context: 'both',
  },
  {
    actionId: 'view.panUp',
    label: 'Pan up',
    key: 'arrowup',
    section: 'navigate',
    context: 'both',
  },
  {
    actionId: 'view.panDown',
    label: 'Pan down',
    key: 'arrowdown',
    section: 'navigate',
    context: 'both',
  },
  // ---- Cheat sheet ---------------------------------------------------------------
  {
    actionId: 'view.showControls',
    label: 'Show controls',
    key: '?',
    section: 'misc',
    context: 'both',
  },
  // ---- Navigate: 2D rotation -----------------------------------------------------
  {
    actionId: 'view.rotateLeft',
    label: 'Rotate map 15° counter-clockwise',
    mouse: {
      dataMap: 'Right-drag (or Ctrl-drag)',
      design: 'Right-drag (or Ctrl-drag)',
    },
    key: '[',
    section: 'navigate',
    context: '2d',
  },
  {
    actionId: 'view.rotateRight',
    label: 'Rotate map 15° clockwise',
    mouse: {
      dataMap: 'Right-drag (or Ctrl-drag)',
      design: 'Right-drag (or Ctrl-drag)',
    },
    key: ']',
    section: 'navigate',
    context: '2d',
  },
  {
    actionId: 'view.resetRotation',
    label: 'Reset map rotation (north up)',
    key: 'n',
    section: 'navigate',
    context: '2d',
  },
  // ---- Navigate: 3D camera presets -----------------------------------------------
  {
    actionId: 'view.top',
    label: 'Top view',
    key: '1',
    section: 'view',
    context: '3d',
  },
  {
    actionId: 'view.front',
    label: 'Front view',
    key: '2',
    section: 'view',
    context: '3d',
  },
  {
    actionId: 'view.side',
    label: 'Side view',
    key: '3',
    section: 'view',
    context: '3d',
  },
  // ---- View toggles --------------------------------------------------------------
  {
    actionId: 'view.toggle3D',
    label: 'Toggle 2D / 3D',
    section: 'view',
    context: 'both',
  },
  {
    actionId: 'view.toggleFullScreen',
    label: 'Toggle full screen',
    section: 'view',
    context: 'both',
  },
  // ---- Tools ---------------------------------------------------------------------
  {
    actionId: 'tool.pan',
    label: 'Pan tool',
    section: 'navigate',
    context: 'both',
  },
  {
    actionId: 'tool.lasso',
    label: 'Lasso select tool',
    section: 'select',
    context: 'both',
  },
  {
    actionId: 'tool.annotate',
    label: 'Annotate tool',
    section: 'annotate',
    context: '2d',
  },
  // ---- Select --------------------------------------------------------------------
  {
    actionId: 'select.all',
    label: 'Select all visible points',
    section: 'select',
    context: 'both',
  },
  {
    actionId: 'select.clear',
    label: 'Clear selection',
    section: 'select',
    context: 'both',
  },
  // ---- Edit ----------------------------------------------------------------------
  {
    actionId: 'edit.undo',
    label: 'Undo',
    mac: 'cmd+z',
    win: 'ctrl+z',
    section: 'misc',
    context: 'both',
  },
  {
    actionId: 'edit.redo',
    label: 'Redo',
    mac: 'cmd+shift+z',
    win: 'ctrl+shift+z',
    section: 'misc',
    context: 'both',
  },
  // ---- Preset-specific: CAD fit keys -------------------------------------------
  {
    actionId: 'view.reset',
    label: 'Fit to view (F)',
    key: 'f',
    section: 'navigate',
    context: 'both',
    preset: ['cad'],
  },
  {
    actionId: 'view.reset',
    label: 'Fit to view (Home)',
    key: 'home',
    section: 'navigate',
    context: 'both',
    preset: ['cad'],
  },
  // ---- Preset-specific: CAD numpad camera views --------------------------------
  {
    actionId: 'view.top',
    label: 'Top view (numpad 7)',
    key: 'numpad7',
    section: 'view',
    context: '3d',
    preset: ['cad'],
  },
  {
    actionId: 'view.front',
    label: 'Front view (numpad 1)',
    key: 'numpad1',
    section: 'view',
    context: '3d',
    preset: ['cad'],
  },
  {
    actionId: 'view.side',
    label: 'Side view (numpad 3)',
    key: 'numpad3',
    section: 'view',
    context: '3d',
    preset: ['cad'],
  },
  // ---- Preset-specific: Design fit key ----------------------------------------
  {
    actionId: 'view.reset',
    label: 'Fit to view (Shift+1)',
    key: 'shift+1',
    section: 'navigate',
    context: 'both',
    preset: ['design'],
  },
];

/**
 * Look up a binding entry by action id.
 */
export function findBinding(actionId: ActionId): BindingEntry | undefined {
  return BINDINGS.find((b) => b.actionId === actionId);
}

/**
 * Return the default key string for an action on the given platform.
 * Returns the platform-specific key (mac / win) when available, else the
 * generic `key`.  Returns null when no default is set.
 */
export function defaultKey(entry: BindingEntry, platform: 'mac' | 'win' | 'linux'): string | null {
  if (platform === 'mac' && entry.mac) return entry.mac;
  if ((platform === 'win' || platform === 'linux') && entry.win) return entry.win;
  return entry.key ?? null;
}

/**
 * Format a key string as a human-readable label for the given platform.
 * Input format: 'ctrl+z', 'cmd+shift+z', '[', 'arrowleft', …
 * Output: macOS glyphs (⌘⌥⇧⌃) or words (Ctrl, Alt, Shift).
 */
export function formatKey(key: string, platform: 'mac' | 'win' | 'linux'): string {
  const isMac = platform === 'mac';
  const parts = key.toLowerCase().split('+');
  const formatted: string[] = [];
  for (const p of parts) {
    switch (p) {
      case 'cmd':
      case 'meta':
        formatted.push(isMac ? '⌘' : 'Win');
        break;
      case 'ctrl':
        formatted.push(isMac ? '⌃' : 'Ctrl');
        break;
      case 'alt':
      case 'option':
        formatted.push(isMac ? '⌥' : 'Alt');
        break;
      case 'shift':
        formatted.push(isMac ? '⇧' : 'Shift');
        break;
      case 'arrowleft':
        formatted.push('←');
        break;
      case 'arrowright':
        formatted.push('→');
        break;
      case 'arrowup':
        formatted.push('↑');
        break;
      case 'arrowdown':
        formatted.push('↓');
        break;
      case 'enter':
        formatted.push(isMac ? '↩' : 'Enter');
        break;
      case 'escape':
        formatted.push(isMac ? '⎋' : 'Esc');
        break;
      case 'home':
        formatted.push('Home');
        break;
      case 'numpad0': case 'numpad1': case 'numpad2': case 'numpad3':
      case 'numpad4': case 'numpad5': case 'numpad6': case 'numpad7':
      case 'numpad8': case 'numpad9':
        formatted.push(`Num ${p.slice(6)}`);
        break;
      default:
        formatted.push(p.toUpperCase());
        break;
    }
  }
  return isMac ? formatted.join('') : formatted.join('+');
}
