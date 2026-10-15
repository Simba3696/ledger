import { base64ToBytes, bytesToBase64 } from "./base64";

// The ledger.json.enc file format (ADR-0007): one JSON header line, "\n",
// then the base64 ciphertext of the gzipped JSON document.
//
//   {"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"<b64>","iv":"<b64>","alg":"AES-GCM-256","z":"gzip"}
//   <base64 ciphertext>
//
// The header line's exact bytes are AES-GCM additional data, so editing it
// (lowering iter, swapping the salt) makes decryption fail rather than being
// trusted. Uses only the crypto, Compression Streams, TextEncoder/Decoder and
// atob/btoa globals, nothing from the DOM, window or IndexedDB, so Node 22
// can import it too (the e2e seeds and inspects the stored file with it).

/** PBKDF2 iterations for a new file. parseHeader refuses fewer. */
export const DEFAULT_ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const KDF = "PBKDF2-SHA256";
const ALG = "AES-GCM-256";
const ZIP = "gzip";

export interface FileHeader {
  v: 1;
  kdf: typeof KDF;
  iter: number;
  /** base64 of 16 bytes */
  salt: string;
  /** base64 of 12 bytes */
  iv: string;
  alg: typeof ALG;
  z: typeof ZIP;
}

/** The file isn't a ledger.json.enc this version can read, or its header
 * asks for something it refuses (a weak KDF, an unknown cipher). */
export class InvalidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFileError";
  }
}

/** AES-GCM refused the data: the key came from another passphrase, or the
 * file (header included) was changed after it was written. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "WrongPassphraseError";
  }
}

/** 16 random bytes for a new file's salt. */
export function newSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** A salt as bytes, or as the base64 a file header carries. */
type Salt = Uint8Array | string;

function saltBytes(salt: Salt): Uint8Array<ArrayBuffer> {
  return typeof salt === "string" ? base64ToBytes(salt) : new Uint8Array(salt);
}

function isAllowedIterations(iter: unknown): iter is number {
  return Number.isInteger(iter) && (iter as number) >= DEFAULT_ITERATIONS && (iter as number) <= MAX_ITERATIONS;
}

/** PBKDF2-SHA256 to a non-extractable AES-GCM-256 key. Takes about a second
 * at 600,000 iterations, which is why the key is kept per device. */
export async function deriveKey(passphrase: string, salt: Salt, iter: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes(salt), iterations: iter },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `bytes` through `transform`. With `maxBytes`, stops reading and throws
 * InvalidFileError once the output passes it, before it is all held. */
async function pipeThrough(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
  maxBytes = Infinity,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  // A corrupt stream rejects both sides; the read below reports it.
  written.catch(() => {});
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new InvalidFileError(`The document is larger than ${maxBytes} bytes`);
    }
  }
  await written;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Encrypts a JSON-serialisable value into the file format. `salt` and
 * `iter` go into the header as given: re-encrypting an existing file passes
 * that file's header values, so other devices' stored keys keep working and
 * only the IV changes. A new file passes newSalt() and DEFAULT_ITERATIONS. */
export async function encryptDocument(
  value: unknown,
  key: CryptoKey,
  { salt, iter }: { salt: Salt; iter: number },
): Promise<string> {
  const saltRaw = saltBytes(salt);
  if (saltRaw.length !== SALT_BYTES) throw new InvalidFileError(`The salt must be ${SALT_BYTES} bytes`);
  if (!isAllowedIterations(iter)) throw new InvalidFileError("The iteration count is out of range");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header: FileHeader = { v: 1, kdf: KDF, iter, salt: bytesToBase64(saltRaw), iv: bytesToBase64(iv), alg: ALG, z: ZIP };
  const headerLine = JSON.stringify(header);
  const plain = await pipeThrough(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("gzip"));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(headerLine) },
    key,
    plain,
  );
  return `${headerLine}\n${bytesToBase64(new Uint8Array(cipher))}`;
}

function splitFile(text: string): { headerLine: string; body: string } {
  const newline = text.indexOf("\n");
  if (newline < 0) throw new InvalidFileError("The file has no header line");
  return { headerLine: text.slice(0, newline), body: text.slice(newline + 1) };
}

function decodedLength(base64: unknown): number | null {
  if (typeof base64 !== "string") return null;
  try {
    return base64ToBytes(base64).length;
  } catch {
    return null;
  }
}

/** Reads and validates the header line. Throws InvalidFileError for any
 * other format version, KDF, cipher or compression, a salt that isn't 16
 * bytes, an IV that isn't 12 bytes, or an iteration count outside
 * 600,000..10,000,000, all before any key is derived. */
export function parseHeader(text: string): FileHeader {
  const { headerLine } = splitFile(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerLine);
  } catch {
    throw new InvalidFileError("The file header is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidFileError("The file header is not an object");
  }
  const h = parsed as Record<string, unknown>;
  if (h.v !== 1) throw new InvalidFileError("Unsupported file version");
  if (h.kdf !== KDF) throw new InvalidFileError("Unsupported key derivation");
  if (h.alg !== ALG) throw new InvalidFileError("Unsupported cipher");
  if (h.z !== ZIP) throw new InvalidFileError("Unsupported compression");
  if (!isAllowedIterations(h.iter)) throw new InvalidFileError("The iteration count is out of range");
  if (decodedLength(h.salt) !== SALT_BYTES) throw new InvalidFileError(`The salt must be ${SALT_BYTES} bytes`);
  if (decodedLength(h.iv) !== IV_BYTES) throw new InvalidFileError(`The IV must be ${IV_BYTES} bytes`);
  return { v: 1, kdf: KDF, iter: h.iter, salt: h.salt as string, iv: h.iv as string, alg: ALG, z: ZIP };
}

/** Decrypts the file format back to the value it was made from. A key from
 * another passphrase, or any changed byte, throws WrongPassphraseError.
 * Plaintext that isn't gzip, or that inflates past `maxPlainBytes`, throws
 * InvalidFileError: gzip can inflate about 1000:1, so a reader of files it
 * didn't write passes a bound. */
export async function decryptDocument(text: string, key: CryptoKey, { maxPlainBytes }: { maxPlainBytes?: number } = {}): Promise<unknown> {
  const header = parseHeader(text);
  const { headerLine, body } = splitFile(text);
  let cipher: Uint8Array<ArrayBuffer>;
  try {
    cipher = base64ToBytes(body);
  } catch {
    throw new InvalidFileError("The file body is not base64");
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(header.iv), additionalData: new TextEncoder().encode(headerLine) },
      key,
      cipher,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "OperationError") throw new WrongPassphraseError();
    throw err;
  }
  let inflated: Uint8Array<ArrayBuffer>;
  try {
    inflated = await pipeThrough(new Uint8Array(plain), new DecompressionStream("gzip"), maxPlainBytes);
  } catch (err) {
    if (err instanceof InvalidFileError) throw err;
    throw new InvalidFileError("The file body is not gzip");
  }
  const json = new TextDecoder().decode(inflated);
  try {
    return JSON.parse(json);
  } catch {
    throw new InvalidFileError("The decrypted document is not valid JSON");
  }
}

export type EnvironmentCheck =
  | { ok: true; warnings: "no-indexeddb"[] }
  | { ok: false; reason: "insecure-context" | "no-compression-stream" | "no-web-locks"; message: string };

/** What this browser lacks for GitHub storage mode. A missing secure context
 * (plain http://, where crypto.subtle is absent), CompressionStream or Web
 * Locks (the one-tab lock the sync engine holds, #7) stops the app; missing
 * IndexedDB (some private windows) only means the key is held in memory for
 * the tab. The messages are shown to the person as is. */
export function checkEnvironment(): EnvironmentCheck {
  if (globalThis.isSecureContext === false || !globalThis.crypto?.subtle) {
    return {
      ok: false,
      reason: "insecure-context",
      message: "Ledger needs a secure (HTTPS) address to encrypt your data. Open it from an https:// link.",
    };
  }
  if (typeof globalThis.CompressionStream !== "function" || typeof globalThis.DecompressionStream !== "function") {
    return {
      ok: false,
      reason: "no-compression-stream",
      message: "This browser is too old to compress your data before encrypting it. Update it, or use a current browser.",
    };
  }
  if (typeof globalThis.navigator?.locks?.request !== "function") {
    return {
      ok: false,
      reason: "no-web-locks",
      message: "This browser is too old to keep two tabs of Ledger from saving over each other. Update it, or use a current browser.",
    };
  }
  return { ok: true, warnings: typeof globalThis.indexedDB === "undefined" ? ["no-indexeddb"] : [] };
}
