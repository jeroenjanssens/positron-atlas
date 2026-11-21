/**
 * Binary payload helpers for the P4 message-encoding change.
 * Accepts Uint8Array (the new binary path) or a base64 string (one-release
 * fallback for hosts that pre-date P4).
 */

/**
 * Normalise a binary payload: accepts a Uint8Array (the new binary path) or a
 * base64 string (one-release fallback for older hosts that pre-date P4).
 */
export function bytesFromPayload(payload: Uint8Array | string): Buffer {
  if (typeof payload === 'string') {
    return Buffer.from(payload, 'base64');
  }
  return Buffer.from(payload);
}
