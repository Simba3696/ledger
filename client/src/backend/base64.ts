// Base64 for byte arrays of any size, using only atob/btoa (browsers and
// Node 22). No DOM, window or IndexedDB, so Node scripts can import it.

// Bytes per String.fromCharCode call. Passing a whole multi-megabyte array
// as arguments overflows the call stack (RangeError), so it goes in slices.
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/** Decodes base64, ignoring whitespace: GitHub's contents API breaks its
 * base64 with a newline every 60 characters. Throws on anything else that
 * isn't base64 (atob's InvalidCharacterError). */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
