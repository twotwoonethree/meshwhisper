/** Generate a base64 JPEG thumbnail from an image File, max 220px on longest side */
export async function generateThumbnail(file: File, maxDim = 220): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(blobUrl);
      resolve(canvas.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('Image load failed')); };
    img.src = blobUrl;
  });
}

/** Read a File into a Uint8Array */
export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Fetch an encrypted media blob from the relay and decrypt it.
 * Relay format: nonce(12) | tag(16) | ciphertext
 */
export async function downloadAndDecrypt(url: string, keyBase64: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Media download failed: ${resp.status}`);
  const blob = new Uint8Array(await resp.arrayBuffer());

  const nonce = blob.slice(0, 12);
  const tag = blob.slice(12, 28);
  const ciphertext = blob.slice(28);

  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);

  // WebCrypto AES-GCM expects ciphertext || tag
  const input = new Uint8Array(ciphertext.length + 16);
  input.set(ciphertext);
  input.set(tag, ciphertext.length);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, input);
  return new Uint8Array(plaintext);
}

/**
 * Sanitize a peer-supplied filename before using it as a download target.
 * Strips directory separators and path-traversal, drops control characters,
 * collapses whitespace, and caps the length. Never returns an empty string.
 */
export function sanitizeFileName(name: string | undefined, fallback = 'download'): string {
  if (!name) return fallback;
  // Take only the basename — defeats "../" and absolute paths.
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '') // control + filesystem-reserved chars
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '') // no leading dots ("." / ".." / hidden-file coercion)
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/**
 * Clamp a peer-supplied MIME type to a safe value for a download Blob. An
 * attacker can mislabel content (e.g. an executable as image/png); forcing
 * an unrecognised or active type to a neutral octet-stream means the browser
 * won't try to render/execute it inline.
 */
export function safeDownloadMime(mimeType: string | undefined): string {
  if (!mimeType || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) return 'application/octet-stream';
  const lowered = mimeType.toLowerCase();
  // Never hand back types the browser may execute/script from a download.
  if (lowered.includes('html') || lowered.includes('javascript') || lowered.includes('xhtml') || lowered === 'image/svg+xml') {
    return 'application/octet-stream';
  }
  return mimeType;
}

/** Trigger a browser save-file dialog for downloaded bytes */
export function triggerDownload(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const safeName = sanitizeFileName(fileName);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: safeDownloadMime(mimeType) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** File-type icon label for display */
export function fileIconLabel(mimeType: string): string {
  if (mimeType.includes('pdf')) return 'PDF';
  if (mimeType.includes('word') || mimeType.includes('docx') || mimeType.includes('doc')) return 'DOC';
  if (mimeType.includes('sheet') || mimeType.includes('xlsx') || mimeType.includes('xls') || mimeType.includes('csv')) return 'XLS';
  if (mimeType.includes('presentation') || mimeType.includes('pptx') || mimeType.includes('ppt')) return 'PPT';
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gzip')) return 'ZIP';
  if (mimeType.startsWith('text/')) return 'TXT';
  return 'FILE';
}
