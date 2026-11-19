import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { bootstrapCode, callCode } from '../src/extension/kernelBridge';
import { isPlainName, parseDataExplorerTabLabel } from '../src/extension/tabLabel';

const root = path.resolve(__dirname, '..');
const python = path.join(root, 'python', '.venv', 'bin', 'python');
const modulePath = path.join(root, 'python', 'positron_atlas_kernel.py');

/** Mimic Positron's _evaluate_code: eval each expression in a shared user namespace. */
function runInKernel(exprs: string[], setup = ''): any {
  const script = `
def _harness():
    import json, __main__
    ns = __main__.__dict__
    exec(${JSON.stringify(setup)}, ns)
    before = set(ns)
    results = [eval(e, ns) for e in json.loads(${JSON.stringify(JSON.stringify(exprs))})]
    print(json.dumps({"results": results, "leaked": sorted(set(ns) - before)}))
_harness()
`;
  const out = execFileSync(python, ['-I', '-c', script], { encoding: 'utf8' });
  return JSON.parse(out);
}

describe.skipIf(!fs.existsSync(python))('kernel bridge code generation', () => {
  it('bootstraps, calls, and leaks nothing into the user namespace', () => {
    const r = runInKernel([bootstrapCode(modulePath, '0.1.0'), callCode('ping', [])]);
    expect(r.leaked).toEqual([]);
    expect(JSON.parse(r.results[1])).toEqual({ ok: true, version: '0.1.0' });
  });

  it('reports not-loaded before bootstrap (kernel restart)', () => {
    const r = runInKernel([callCode('ping', [])]);
    expect(JSON.parse(r.results[0])).toEqual({ ok: false, error: '__not_loaded__' });
  });

  it('passes tricky strings safely', () => {
    const name = `we"ird\\n'nameé`;
    const r = runInKernel([bootstrapCode(modulePath, '0.1.0'), callCode('describe', [name])]);
    const res = JSON.parse(r.results[1]);
    expect(res.ok).toBe(false);
    expect(r.leaked).toEqual([]);
  });

  it('describes a DataFrame defined in the namespace', () => {
    const r = runInKernel(
      [bootstrapCode(modulePath, '0.1.0'), callCode('describe', ['df'])],
      'import pandas as pd\ndf = pd.DataFrame({"a": [1.0, 2.0], "b": ["x", "y"]})',
    );
    const res = JSON.parse(r.results[1]);
    expect(res.ok).toBe(true);
    expect(res.nRows).toBe(2);
    expect(res.columns.map((c: any) => c.kind)).toEqual(['numeric', 'categorical']);
  });

  it('reloads the module when the version changes', () => {
    const r = runInKernel([
      bootstrapCode(modulePath, '0.1.0'),
      '__import__("sys").modules["_positron_atlas"].__dict__.setdefault("MARK", 1)',
      bootstrapCode(modulePath, '0.1.0'),
      '"MARK" in __import__("sys").modules["_positron_atlas"].__dict__',
      bootstrapCode(modulePath, '9.9.9'),
      '"MARK" in __import__("sys").modules["_positron_atlas"].__dict__',
    ]);
    expect(r.results[3]).toBe(true);
    expect(r.results[5]).toBe(false);
  });
});

describe('Data Explorer tab label', () => {
  it('parses the variable name', () => {
    expect(parseDataExplorerTabLabel('Data: df')).toBe('df');
    expect(parseDataExplorerTabLabel('Data: my_frame ')).toBe('my_frame');
    expect(parseDataExplorerTabLabel('Data Explorer')).toBeUndefined();
    expect(parseDataExplorerTabLabel(undefined)).toBeUndefined();
  });
});

describe('isPlainName', () => {
  it('accepts identifiers and attribute chains only', () => {
    expect(isPlainName('df')).toBe(true);
    expect(isPlainName('data.train_set')).toBe(true);
    expect(isPlainName('df[0]')).toBe(false);
    expect(isPlainName('data.csv ')).toBe(false);
    expect(isPlainName('__import__("os").system("x")')).toBe(false);
    expect(isPlainName('1abc')).toBe(false);
  });
});
