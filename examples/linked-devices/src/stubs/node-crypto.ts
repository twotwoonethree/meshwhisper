// Browser polyfill for node:crypto's randomBytes used by the SDK packet layer
export function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}
