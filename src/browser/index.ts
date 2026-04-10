// ============================================================
// MeshWhisper SDK — Browser / PWA entry point
// @meshwhisper/sdk/browser
//
// Re-exports everything from the main SDK plus browser-specific
// storage and transport implementations.
//
// Usage:
//   import { MeshWhisper, IDBStorage, BrowserTransport } from '@meshwhisper/sdk/browser';
//
// When you call MeshWhisper.init() in a browser environment, the SDK
// detects window/indexedDB and auto-selects IDBStorage + BrowserTransport.
// You only need to import from this path if you want to reference the
// classes explicitly (e.g. to construct IDBStorage with a custom namespace).
// ============================================================

export * from '../index.js';
export { IDBStorage } from '../persistence/idb-storage.js';
export { BrowserTransport } from '../transport/browser/index.js';
