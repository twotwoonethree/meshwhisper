// ============================================================
// MeshWhisper SDK — React Native entry point
// @meshwhisper/sdk/react-native
//
// Re-exports everything from the main SDK plus:
//
//   - AsyncStorageBackend — a StorageBackend implementation over
//     @react-native-async-storage/async-storage. The consumer passes
//     AsyncStorage in (peer-dependency style) so the SDK stays
//     platform-agnostic and doesn't pull RN-only modules into other
//     builds.
//   - ReactNativeTransport — alias for BrowserTransport. RN's
//     WebSocket / fetch primitives are sufficient; no native module
//     is required.
//
// Minimal setup:
//
//   import AsyncStorage from '@react-native-async-storage/async-storage';
//   import { MeshWhisper, AsyncStorageBackend } from '@meshwhisper/sdk/react-native';
//
//   await MeshWhisper.init({
//     namespace: 'com.yourapp',
//     node: 'wss://relay.yourapp.com',
//     storage: new AsyncStorageBackend(AsyncStorage, 'com.yourapp'),
//   });
//
// On RN-specific gotchas, see docs/api.md "Storage backends > React Native".
// ============================================================

export * from '../index.js';
export { BrowserTransport as ReactNativeTransport } from '../transport/browser/index.js';
export { AsyncStorageBackend } from '../persistence/async-storage.js';
export type { AsyncStorageLike } from '../persistence/async-storage.js';
