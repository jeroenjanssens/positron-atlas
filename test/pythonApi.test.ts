import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/webview/vscode', () => ({ vscode: { post: vi.fn() } }));
import { resolveColumn } from '../src/webview/atlas/api';

describe('resolveColumn (Python API column names)', () => {
  const atlas = {
    describe: { columns: [{ index: 0, name: 'x0' }, { index: 5, name: 'phase' }] },
  } as unknown as Parameters<typeof resolveColumn>[0];

  it('maps a name to its column index', () => {
    expect(resolveColumn(atlas, { columnName: 'phase' })).toBe(5);
  });
  it('accepts a valid index', () => {
    expect(resolveColumn(atlas, { column: 0 })).toBe(0);
  });
  it('explains unknown names and indices', () => {
    expect(resolveColumn(atlas, { columnName: 'nope' })).toMatch(/no column named "nope".*x0, phase/);
    expect(resolveColumn(atlas, { column: 9 })).toMatch(/no column with index 9/);
  });
});
