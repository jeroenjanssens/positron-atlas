import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { webviewCsp } from '../src/shared/csp';

describe('webview Content-Security-Policy', () => {
  it('the harness page uses the same policy as the extension host', () => {
    const html = readFileSync('test/harness/index.html', 'utf8');
    const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(meta?.[1]).toBe(webviewCsp("'self'", 'harness'));
  });

  it('allows the inlined codicon font (a data: URL)', () => {
    expect(webviewCsp('x', 'n')).toMatch(/font-src x data:/);
  });
});
