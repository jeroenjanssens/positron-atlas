import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { HELP } from '../src/webview/help';
import type { HelpEntry } from '../src/webview/help';

/** Collect all .svelte files under a directory recursively. */
function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...svelteFiles(full));
    else if (entry.name.endsWith('.svelte')) out.push(full);
  }
  return out;
}

/** Extract all Help ids referenced in .svelte files via <Info id="..."/> and infoId="...". */
function referencedIds(): Set<string> {
  const componentsDir = join(__dirname, '../src/webview/components');
  const ids = new Set<string>();
  for (const file of svelteFiles(componentsDir)) {
    const src = readFileSync(file, 'utf-8');
    // <Info id="toolbar.pan" /> or <Info id='toolbar.pan' />
    for (const m of src.matchAll(/<Info\s+id=["']([\w.]+)["']\s*\/>/g)) ids.add(m[1]);
    // infoId="data.pcaDims" (Slider prop) followed by whitespace or />
    for (const m of src.matchAll(/infoId=["']([\w.]+)["'][\s/>]/g)) ids.add(m[1]);
  }
  return ids;
}

const VALID_COSTS: HelpEntry['cost'][] = ['live', 'rebuild', 'reprepare', 'none'];
const ID_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

describe('HELP entries', () => {
  const ids = Object.keys(HELP);

  it('has at least one entry', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it('all ids are unique', () => {
    const seen = new Set<string>();
    for (const id of ids) {
      expect(seen.has(id), `Duplicate id: ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it('all ids follow the section.name pattern', () => {
    for (const id of ids) {
      expect(ID_PATTERN.test(id), `Id "${id}" does not match section.name pattern`).toBe(true);
    }
  });

  it('every entry has a non-empty title', () => {
    for (const [id, entry] of Object.entries(HELP)) {
      expect(entry.title.trim().length, `title is empty for "${id}"`).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty what', () => {
    for (const [id, entry] of Object.entries(HELP)) {
      expect(entry.what.trim().length, `what is empty for "${id}"`).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty intuition', () => {
    for (const [id, entry] of Object.entries(HELP)) {
      expect(entry.intuition.trim().length, `intuition is empty for "${id}"`).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid cost', () => {
    for (const [id, entry] of Object.entries(HELP)) {
      expect(VALID_COSTS.includes(entry.cost), `cost "${entry.cost}" is invalid for "${id}"`).toBe(true);
    }
  });

  it('live-cost entries are only UMAP optimization parameters', () => {
    const liveIds = ids.filter((id) => HELP[id].cost === 'live');
    for (const id of liveIds) {
      expect(id.startsWith('umap.'), `Non-UMAP entry "${id}" has cost "live"`).toBe(true);
    }
  });

  it('rebuild-cost entries are only UMAP parameters', () => {
    const rebuildIds = ids.filter((id) => HELP[id].cost === 'rebuild');
    for (const id of rebuildIds) {
      expect(id.startsWith('umap.'), `Non-UMAP entry "${id}" has cost "rebuild"`).toBe(true);
    }
  });

  it('reprepare-cost entries are only data parameters', () => {
    const reprepareIds = ids.filter((id) => HELP[id].cost === 'reprepare');
    for (const id of reprepareIds) {
      expect(id.startsWith('data.'), `Non-data entry "${id}" has cost "reprepare"`).toBe(true);
    }
  });

  it('covers all expected sections', () => {
    const sections = new Set(ids.map((id) => id.split('.')[0]));
    const expected = ['data', 'umap', 'result', 'explore', 'labels', 'tags', 'export', 'toolbar', 'titleOverlay', 'pointAnnotations'];
    for (const s of expected) {
      expect(sections.has(s), `No entries for section "${s}"`).toBe(true);
    }
  });

  it('covers the key UMAP parameters', () => {
    const umapIds = new Set(ids.filter((id) => id.startsWith('umap.')).map((id) => id.split('.')[1]));
    for (const param of ['nNeighbors', 'minDist', 'spread', 'nEpochs', 'metric', 'seed', 'repulsionStrength', 'negativeSampleRate', 'learningRate', 'computeMode']) {
      expect(umapIds.has(param), `Missing UMAP entry for "${param}"`).toBe(true);
    }
  });

  it('covers the key data parameters', () => {
    const dataIds = new Set(ids.filter((id) => id.startsWith('data.')).map((id) => id.split('.')[1]));
    for (const param of ['features', 'samplePct', 'standardize', 'pca', 'pcaDims', 'anchors', 'missingValues', 'seed', 'apply']) {
      expect(dataIds.has(param), `Missing data entry for "${param}"`).toBe(true);
    }
  });

  it('optional when field, if present, is a non-empty string', () => {
    for (const [id, entry] of Object.entries(HELP)) {
      if (entry.when !== undefined) {
        expect(typeof entry.when, `when for "${id}" is not a string`).toBe('string');
        expect(entry.when.trim().length, `when is empty for "${id}"`).toBeGreaterThan(0);
      }
    }
  });

  it('optional dataMapPlot field, if present, is a non-empty string', () => {
    for (const [id, entry] of Object.entries(HELP)) {
      if (entry.dataMapPlot !== undefined) {
        expect(typeof entry.dataMapPlot, `dataMapPlot for "${id}" is not a string`).toBe('string');
        expect(entry.dataMapPlot.trim().length, `dataMapPlot is empty for "${id}"`).toBeGreaterThan(0);
      }
    }
  });
});

// ---- I3: cross-reference checks (I3) -----------------------------------------

describe('Info component cross-references (I3)', () => {
  const inComponents = referencedIds();

  it('every <Info id> and infoId used in a component exists in help.ts', () => {
    for (const id of inComponents) {
      expect(id in HELP, `Component references id "${id}" which is not in HELP`).toBe(true);
    }
  });

  it('every help.ts id is referenced by at least one component (no dead entries)', () => {
    // Toolbar entries are shown via button title= attributes rather than Info popovers;
    // they are exempt from the component-reference check.
    const toolbarExempt = new Set(['toolbar.pan', 'toolbar.lasso', 'toolbar.fitView', 'toolbar.annotate']);
    for (const id of Object.keys(HELP)) {
      if (toolbarExempt.has(id)) continue;
      expect(inComponents.has(id), `HELP entry "${id}" is not referenced in any component`).toBe(true);
    }
  });
});
