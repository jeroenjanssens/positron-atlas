import { describe, expect, it } from 'vitest';

// Mirror the JSONC stripping + parsing logic from atlasPanel.ts
function parseJsonc(raw: string): unknown {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(stripped);
}

describe('JSONC keybindings parsing', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('[{"command": "foo", "key": "ctrl+a"}]')).toEqual([{ command: 'foo', key: 'ctrl+a' }]);
  });

  it('strips line comments', () => {
    const input = `[
      // this is a comment
      {"command": "foo", "key": "ctrl+a"}
    ]`;
    expect(parseJsonc(input)).toEqual([{ command: 'foo', key: 'ctrl+a' }]);
  });

  it('strips block comments', () => {
    const input = `[/* block comment */ {"command": "bar", "key": "ctrl+b"}]`;
    expect(parseJsonc(input)).toEqual([{ command: 'bar', key: 'ctrl+b' }]);
  });

  it('strips trailing commas in arrays', () => {
    const input = `[{"command": "foo", "key": "x"}, ]`;
    expect(parseJsonc(input)).toEqual([{ command: 'foo', key: 'x' }]);
  });

  it('strips trailing commas in objects', () => {
    const input = `[{"command": "foo", "key": "x",}]`;
    expect(parseJsonc(input)).toEqual([{ command: 'foo', key: 'x' }]);
  });

  it('handles empty array', () => {
    expect(parseJsonc('[]')).toEqual([]);
  });

  it('handles keybindings.json with everything', () => {
    const input = `[
      // User keybindings
      { "command": "positronAtlas.nav.view.reset", "key": "shift+r" }, // my custom key
      /* old binding */ { "command": "positronAtlas.nav.view.zoomIn", "key": "ctrl+equal", },
    ]`;
    const result = parseJsonc(input) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('positronAtlas.nav.view.reset');
    expect(result[1].key).toBe('ctrl+equal');
  });

  it('handles multi-line block comments', () => {
    const input = `[
      /*
       * This is a multi-line
       * block comment
       */
      {"command": "positronAtlas.nav.view.reset", "key": "r"}
    ]`;
    expect(parseJsonc(input)).toEqual([{ command: 'positronAtlas.nav.view.reset', key: 'r' }]);
  });

  it('strips trailing comma from nested object', () => {
    const input = `[{"command": "foo", "key": "x", "args": {"a": 1,}}]`;
    const result = parseJsonc(input) as any[];
    expect(result[0].args).toEqual({ a: 1 });
  });
});
