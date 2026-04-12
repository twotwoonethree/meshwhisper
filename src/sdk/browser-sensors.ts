// ============================================================
// MeshWhisper SDK — Browser sensor utilities
//
// Provides two exports for PWA / browser apps:
//
//   requestSensorPermission()
//     Call this once from a user-gesture handler (button tap) at app
//     startup on iOS. iOS 13+ requires DeviceMotionEvent.requestPermission()
//     to be called from inside a touch/click event — it will silently fail if
//     called from a background callback such as onEntropyChallenge.
//     Safe to call on Android and desktop (no-op or returns true immediately).
//
//   collectSensorData(sensorType, durationMs)
//     Reference implementation of onEntropyChallenge that collects the
//     required sensor readings using DeviceMotionEvent / DeviceOrientationEvent.
//     Pass it directly to MeshWhisperConfig.onEntropyChallenge:
//
//       import { requestSensorPermission, collectSensorData } from '@meshwhisper/sdk/browser-sensors'
//
//       // On your "Enable messaging" button:
//       await requestSensorPermission()
//
//       MeshWhisper.init({
//         namespace: 'com.example.myapp',
//         onEntropyChallenge: (_peerId, sensorType, durationMs) =>
//           collectSensorData(sensorType, durationMs),
//       })
//
// ============================================================

import type { EntropySensorType } from '../types.js';

// ----------------------------------------------------------------
// Permission request (iOS gate)
// ----------------------------------------------------------------

/**
 * Requests DeviceMotion / DeviceOrientation permission on iOS 13+.
 *
 * Must be called from inside a user-gesture handler (tap, click).
 * Calling it from a background callback will silently fail on iOS.
 *
 * Returns true if permission was granted (or not needed on this platform),
 * false if denied or unavailable.
 */
export async function requestSensorPermission(): Promise<boolean> {
  // Server-side or desktop environment — no sensor API at all
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
    return false;
  }

  // iOS 13+ requires explicit permission
  const dme = DeviceMotionEvent as unknown as {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof dme.requestPermission === 'function') {
    try {
      const result = await dme.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  // Android / non-iOS browser — permission not required
  return true;
}

// ----------------------------------------------------------------
// Sensor data collection
// ----------------------------------------------------------------

/**
 * Collects raw sensor readings for the requested duration.
 *
 * Sensor mapping:
 *   accelerometer  → DeviceMotionEvent.accelerationIncludingGravity (x, y, z)
 *   gyroscope      → DeviceMotionEvent.rotationRate (alpha, beta, gamma)
 *   magnetometer   → DeviceOrientationEvent absolute (alpha, beta, gamma)
 *
 * Throws if no readings were received (sensor unavailable, permission denied,
 * or running on a desktop without physical sensors).
 */
export function collectSensorData(
  sensorType: EntropySensorType,
  durationMs: number,
): Promise<Float64Array> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Sensor API not available outside a browser context'));
      return;
    }

    const samples: number[] = [];

    if (sensorType === 'magnetometer') {
      const handler = (event: DeviceOrientationEvent): void => {
        // Use absolute orientation (compass-referenced) when available;
        // fall back to relative orientation which still yields varying data.
        samples.push(event.alpha ?? 0, event.beta ?? 0, event.gamma ?? 0);
      };

      window.addEventListener('deviceorientationabsolute' as 'deviceorientation', handler as EventListener);
      // Fallback listener in case absolute variant fires nothing
      window.addEventListener('deviceorientation', handler as EventListener);

      setTimeout(() => {
        window.removeEventListener('deviceorientationabsolute' as 'deviceorientation', handler as EventListener);
        window.removeEventListener('deviceorientation', handler as EventListener);
        finish();
      }, durationMs);
    } else {
      const handler = (event: DeviceMotionEvent): void => {
        if (sensorType === 'accelerometer') {
          const a = event.accelerationIncludingGravity;
          samples.push(a?.x ?? 0, a?.y ?? 0, a?.z ?? 0);
        } else {
          // gyroscope
          const r = event.rotationRate;
          samples.push(r?.alpha ?? 0, r?.beta ?? 0, r?.gamma ?? 0);
        }
      };

      window.addEventListener('devicemotion', handler);

      setTimeout(() => {
        window.removeEventListener('devicemotion', handler);
        finish();
      }, durationMs);
    }

    function finish(): void {
      if (samples.length === 0) {
        reject(new Error(
          `No ${sensorType} data collected — sensor may be unavailable or permission not granted. ` +
          `Call requestSensorPermission() from a user-gesture handler before initialising MeshWhisper.`,
        ));
        return;
      }
      resolve(new Float64Array(samples));
    }
  });
}
