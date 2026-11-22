/**
 * Viewer entry point (X1/X3).
 *
 * Reads the gzipped Atlas blob embedded as base64 in
 *   <script id="atlas-data" type="application/octet-stream">…</script>
 * decompresses it, and mounts the ViewerApp Svelte component.
 */

import { mount } from 'svelte';
import ViewerApp from './ViewerApp.svelte';
import { base64ToUint8, gunzipBytes, unpackBlob } from '../shared/viewerBlob';

async function main(): Promise<void> {
  const el = document.getElementById('atlas-data');
  if (!el) {
    document.body.innerHTML = '<p style="color:#f88;padding:2rem">Atlas data not found in this page.</p>';
    return;
  }
  const b64 = el.textContent?.trim() ?? '';
  const gzipped = base64ToUint8(b64);
  const raw = await gunzipBytes(gzipped);
  const blob = unpackBlob(raw);

  mount(ViewerApp, { target: document.getElementById('app')!, props: { blob } });
}

main().catch((e) => {
  console.error('Atlas viewer error:', e);
  document.body.innerHTML = `<p style="color:#f88;padding:2rem">Failed to load: ${String(e)}</p>`;
});
