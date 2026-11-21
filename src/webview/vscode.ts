import type { PanelState, ToHost } from '../shared/protocol';

const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

export const vscode = {
  post(msg: ToHost): void {
    api?.postMessage(msg);
  },
  getState(): PanelState | undefined {
    return api?.getState();
  },
  setState(state: PanelState): void {
    api?.setState(state);
  },
};

/** Return a Uint8Array view over a Float32Array's bytes (little-endian). */
export function float32ToBytes(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Return a Uint8Array view over a typed array's bytes. */
export function typedArrayToBytes(arr: ArrayBufferView): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

// --- Fallback helpers for older hosts that send/receive base64 strings ---

/** Decode a base64 string to Uint8Array (fallback for legacy hosts). */
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array to base64 (kept for one-release backward compat). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(s);
}

/** Encode a Float32Array to base64 (kept for one-release backward compat). */
export function float32ToBase64(arr: Float32Array): string {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

export async function fetchTyped(uri: string, dtype: 'f32' | 'u16' | 'u32'): Promise<Float32Array | Uint16Array | Uint32Array> {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Failed to load ${uri}: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return dtype === 'f32' ? new Float32Array(buf) : dtype === 'u16' ? new Uint16Array(buf) : new Uint32Array(buf);
}
