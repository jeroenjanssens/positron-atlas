/**
 * Positron titles Data Explorer tabs "Data: <display name>"
 * (positronDataExplorerEditor.tsx). Returns the display name, or undefined.
 */
export function parseDataExplorerTabLabel(label: string | undefined): string | undefined {
  if (!label) {
    return undefined;
  }
  const m = /^Data:\s+(.+)$/.exec(label.trim());
  return m ? m[1].trim() : undefined;
}

/** A Python identifier or dotted attribute chain (e.g. `df` or `data.train`). */
export function isPlainName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);
}
