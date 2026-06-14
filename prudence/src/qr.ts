// Helpers for QR-based contact pairing. The SDK owns the crypto:
//   MeshWhisper.generateContactQR()  -> base64 string (peerId + prekey bundle)
//   MeshWhisper.acceptContact(data)  -> sets the bundle + initiates the handshake
// acceptContact returns void, so to send a follow-up contact_request and open
// the conversation we need the peer's id. It's the length-prefixed prefix of the
// QR payload — parse it here, mirroring the SDK's generateContactQR format:
//   [uint16 BE peerIdLen][peerId UTF-8 bytes][serialized bundle], base64 (standard).

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
}

/** Extract the peerId embedded in a scanned/pasted contact-QR payload. */
export function peerIdFromContactQR(data: string): string {
  const raw = base64ToBytes(data);
  if (raw.length < 2) throw new Error('Invalid contact code');
  const peerIdLen = (raw[0] << 8) | raw[1];
  if (peerIdLen <= 0 || 2 + peerIdLen > raw.length) throw new Error('Invalid contact code');
  return new TextDecoder().decode(raw.slice(2, 2 + peerIdLen));
}

/** Cheap structural validation before handing a pasted string to the SDK. */
export function looksLikeContactQR(data: string): boolean {
  try {
    return peerIdFromContactQR(data).length >= 16;
  } catch {
    return false;
  }
}
