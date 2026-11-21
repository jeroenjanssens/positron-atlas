import { describe, expect, it } from 'vitest';
import { HELP } from '../src/webview/help';
import type { HelpEntry } from '../src/webview/help';

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
    const expected = ['data', 'umap', 'result', 'explore', 'labels', 'tags', 'export', 'toolbar'];
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
