// Files the extension host loads from its install folder at runtime must be shipped in the VSIX.
// .vscodeignore excludes everything (`**`) and re-includes paths with `!…`; a path the host reads
// that isn't re-included works in development and fails in an installed extension.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

/** `!pattern` lines of .vscodeignore as regular expressions (`**` any path, `*` within one segment). */
function includes(): RegExp[] {
  return readFileSync(join(root, '.vscodeignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('!'))
    .map((l) => {
      const glob = l.slice(1);
      const re = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*');
      return new RegExp(`^${re}$`);
    });
}

/** Literal paths passed to `joinPath(<extensionUri>, 'a', 'b', ...)` in the extension host sources. */
function hostAssetPaths(): string[] {
  const dir = join(root, 'src', 'extension');
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/joinPath\([\w.]*extensionUri,\s*((?:'[^']+'\s*,?\s*)+)\)/g)) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map((p) => p[1]);
      out.add(parts.join('/'));
    }
  }
  return [...out].sort();
}

describe('VSIX packaging', () => {
  const patterns = includes();
  const globs = readFileSync(join(root, '.vscodeignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('!'))
    .map((l) => l.slice(1));
  // A file must match an include pattern; a folder (no extension, e.g. a webview resource root)
  // only needs something inside it to be shipped.
  const isFolder = (p: string) => !/\.[a-z0-9]+$/i.test(p);
  const shipped = (p: string) =>
    isFolder(p) ? globs.some((g) => g.startsWith(`${p}/`)) : patterns.some((re) => re.test(p));

  it('finds the host asset paths', () => {
    expect(hostAssetPaths()).toContain('dist/viewer/viewer.js');
  });

  it('ships every file or folder the extension host loads at runtime', () => {
    expect(hostAssetPaths().filter((p) => !shipped(p))).toEqual([]);
  });
});
