// Every message the webview can send (ToHost in src/shared/protocol.ts) must be handled by the
// real extension host (src/extension/atlasPanel.ts) and by the browser harness's stand-in
// (test/harness/host.js). Otherwise a feature can pass in the harness and do nothing in Positron,
// or the other way round.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

function toHostTypes(): string[] {
  const src = read('src/shared/protocol.ts');
  const start = src.indexOf('export type ToHost');
  expect(start, 'ToHost type not found in protocol.ts').toBeGreaterThanOrEqual(0);
  // The union ends at the first semicolon that closes the type alias (followed by a blank line or EOF).
  const rest = src.slice(start);
  const end = rest.search(/;\s*(\n\s*\n|$)/);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  return [...new Set([...block.matchAll(/type:\s*'([A-Za-z]+)'/g)].map((m) => m[1]))].sort();
}

function handled(src: string): Set<string> {
  return new Set([...src.matchAll(/case\s+'([A-Za-z]+)'\s*:/g)].map((m) => m[1]));
}

describe('ToHost message handlers', () => {
  const types = toHostTypes();

  it('finds the ToHost message types', () => {
    expect(types.length).toBeGreaterThan(10);
  });

  it('are all handled by the extension host (atlasPanel.ts)', () => {
    const cases = handled(read('src/extension/atlasPanel.ts'));
    expect(types.filter((t) => !cases.has(t))).toEqual([]);
  });

  it('are all handled by the browser harness host (test/harness/host.js)', () => {
    const cases = handled(read('test/harness/host.js'));
    expect(types.filter((t) => !cases.has(t))).toEqual([]);
  });
});
