/**
 * The webview's Content-Security-Policy. One definition for the extension host and the
 * browser harness (test/harness/index.html carries the same policy, checked by
 * test/csp.test.ts), so a resource the policy blocks in Positron is blocked in tests too.
 *
 * `source` is the webview's resource origin (`webview.cspSource`; `'self'` in the harness).
 * Fonts include `data:` because vite inlines the codicon font as a data URL.
 */
export function webviewCsp(source: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${source} data: blob:`,
    `style-src ${source} 'unsafe-inline'`,
    `font-src ${source} data:`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `worker-src blob:`,
    `connect-src ${source} data: blob:`,
  ].join('; ');
}
