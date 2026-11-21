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

export function float32ToBase64(arr: Float32Array): string {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(s);
}

export async function fetchTyped(uri: string, dtype: 'f32' | 'u16' | 'u32'): Promise<Float32Array | Uint16Array | Uint32Array> {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Failed to load ${uri}: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return dtype === 'f32' ? new Float32Array(buf) : dtype === 'u16' ? new Uint16Array(buf) : new Uint32Array(buf);
}
