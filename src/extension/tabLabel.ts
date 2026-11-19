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
