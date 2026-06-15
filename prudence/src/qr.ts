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

/** Extract the peerId embedded in a scanned/pasted contact-QR payload.
 *  Tolerates both the original format and the interop format (ADR-009), which
 *  prepends a 0x01 version byte + the sender's namespace id. */
export function peerIdFromContactQR(data: string): string {
  const raw = base64ToBytes(data);
  let off = 0;
  if (raw[0] === 0x01) { // interop format: [0x01][u16 nsLen][nsId]…
    const nsLen = (raw[1] << 8) | raw[2];
    off = 3 + nsLen;
  }
  if (off + 2 > raw.length) throw new Error('Invalid contact code');
  const peerIdLen = (raw[off] << 8) | raw[off + 1];
  if (peerIdLen <= 0 || off + 2 + peerIdLen > raw.length) throw new Error('Invalid contact code');
  return new TextDecoder().decode(raw.slice(off + 2, off + 2 + peerIdLen));
}

/** Cheap structural validation before handing a pasted string to the SDK. */
export function looksLikeContactQR(data: string): boolean {
  try {
    return peerIdFromContactQR(data).length >= 16;
  } catch {
    return false;
  }
}
