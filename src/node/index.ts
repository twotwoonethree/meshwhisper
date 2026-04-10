// ============================================================
// MeshWhisper SDK — Node.js entry point
// @meshwhisper/sdk/node
//
// Re-exports everything from the main SDK plus Node.js-specific
// storage and transport implementations.
//
// Usage:
//   import { MeshWhisper, NodeStorage } from '@meshwhisper/sdk/node';
//
//   const mw = await MeshWhisper.init({
//     namespace: 'com.example.app',
//     storage: new NodeStorage('./data'),
//   });
// ============================================================

export * from '../index.js';
export { NodeStorage } from '../persistence/node-storage.js';
export { NodeTransport } from '../transport/node/index.js';
