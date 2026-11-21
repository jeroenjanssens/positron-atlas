/**
 * Write labels/tags back to the DataFrame (tags, clusters, write-back).
 */

import type { Atlas } from '../atlas.svelte';
import type { DescribeResult } from '../../shared/protocol';
import { vscode, bytesToBase64 } from '../vscode';
import { formatCount } from '../logic';
import { requestLabelCodes } from './labels';
import { requestColors } from './colors';

/** Tag the selected rows: write `tag` into a string column; other rows keep their value. */
export function tagSelection(atlas: Atlas, tag: string, column: string): void {
  const t = tag.trim();
  if (!atlas.selection || !t || !column.trim()) return;
  const codes = new Uint16Array(atlas.nKept).fill(65535);
  for (let i = 0; i < codes.length; i++) if (atlas.selection[i]) codes[i] = 0;
  vscode.post({
    type: 'writeLabels',
    codes: bytesToBase64(new Uint8Array(codes.buffer)),
    names: [t],
    column: column.trim(),
    keepOthers: true,
    description: `Tag ${formatCount(atlas.selectedCount)} rows as "${t}"`,
  });
}

/** Write the automatic cluster names into a column (rows in no cluster: missing). */
export function clustersToFrame(atlas: Atlas, column: string): void {
  const c = atlas.cluster;
  if (!c || !column.trim() || atlas.clusterNames.length !== c.k) return;
  vscode.post({
    type: 'writeLabels',
    codes: bytesToBase64(new Uint8Array(c.codes.buffer, c.codes.byteOffset, c.codes.byteLength)),
    names: atlas.clusterNames.slice(),
    column: column.trim(),
    keepOthers: false,
    description: `Write the names of ${formatCount(c.k)} clusters`,
  });
}

export function onLabelsWritten(atlas: Atlas, variable: string, column: string, rows: number, describe: DescribeResult): void {
  atlas.dataVariable = variable;
  atlas.flash(`Wrote ${formatCount(rows)} labels to ${variable}.${column}`);
  const old = atlas.describe;
  if (old && describe.columns.length >= old.columns.length && old.columns.every((c, i) => describe.columns[i]?.name === c.name)) {
    atlas.describe = describe;
    const idx = describe.columns.findIndex((c) => c.name === column);
    if (idx === atlas.labels.column && !atlas.labels.clusters) requestLabelCodes(atlas);
    if (idx === atlas.colorColumn) requestColors(atlas);
    if (atlas.nameSource?.column === idx) {
      atlas.nameSource = null;
      atlas.nameClusters();
    }
  }
}
