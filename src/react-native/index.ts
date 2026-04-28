// ============================================================
// MeshWhisper SDK — React Native entry point
// @meshwhisper/sdk/react-native
//
// Re-exports everything from the main SDK. The init() function
// auto-detects React Native and uses the native WebSocket API
// (via BrowserTransport) rather than the Node.js `ws` package.
//
// React Native has no built-in persistent storage, so you must
// provide a StorageBackend via config.storage. The simplest
// approach is a thin AsyncStorage wrapper:
//
//   import AsyncStorage from '@react-native-async-storage/async-storage';
//
//   class AsyncStorageAdapter {
//     async get(key: string) { return AsyncStorage.getItem(key); }
//     async set(key: string, value: string) { AsyncStorage.setItem(key, value); }
//     async delete(key: string) { AsyncStorage.removeItem(key); }
//     async keys(prefix: string) {
//       const all = await AsyncStorage.getAllKeys();
//       return (all ?? []).filter((k) => k.startsWith(prefix));
//     }
//   }
//
//   await MeshWhisper.init({
//     namespace: 'com.example.app',
//     storage: new AsyncStorageAdapter(),
//   });
// ============================================================

export * from '../index.js';
export { BrowserTransport as ReactNativeTransport } from '../transport/browser/index.js';
