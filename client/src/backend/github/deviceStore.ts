import type { FileHeader } from "../crypto";

// The one place GitHub storage mode keeps anything on the device: the
// derived key and the GitHub connection (token included), in IndexedDB.
// Nothing else stores the token, and never in localStorage. "Forget this
// device" deletes the whole database.

const DB_NAME = "ledger:github";
const DB_VERSION = 1;
const STORE = "device";
const KEY_RECORD = "ledger:key";
const CONNECTION_RECORD = "ledger:connection";

/** The key derived from the passphrase, with the header values it was
 * derived for. `key` is stored by structured clone and stays
 * non-extractable. */
export interface StoredKey {
  key: CryptoKey;
  /** base64, as in the file header */
  salt: string;
  iter: number;
}

/** How this device reaches the data file. `kind: "pat"` is a pasted
 * fine-grained token; `kind: "app"` is a GitHub App user token with its
 * refresh fields. `expiresAt` is optional: a browser can't read GitHub's
 * token-expiration header (CORS doesn't expose it), so it is set only when
 * the expiry is known another way, such as an App token's `expires_in`. */
export interface Connection {
  kind: "pat" | "app";
  token: string;
  owner: string;
  repo: string;
  path: string;
  login: string;
  expiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

/** This browser has no usable IndexedDB (some private windows). The caller
 * keeps the key in memory for the tab instead. */
export class DeviceStoreUnavailableError extends Error {
  constructor(message = "This browser can't keep data on this device") {
    super(message);
    this.name = "DeviceStoreUnavailableError";
  }
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new DeviceStoreUnavailableError());
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new DeviceStoreUnavailableError(String(err)));
      return;
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      // Let another tab's forgetDevice() delete the database.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    // Some private windows refuse to open any database.
    request.onerror = () => reject(new DeviceStoreUnavailableError(request.error?.message));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const result = settle(fn(tx.objectStore(STORE)));
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    // Resolved only once the transaction has committed.
    const [value] = await Promise.all([result, done]);
    return value;
  } finally {
    db.close();
  }
}

async function getRecord<T>(id: string): Promise<T | null> {
  const value = await withStore<unknown>("readonly", (store) => store.get(id));
  return (value ?? null) as T | null;
}

async function putRecord(id: string, value: object): Promise<void> {
  await withStore("readwrite", (store) => store.put(value, id));
}

export function saveKey(record: StoredKey): Promise<void> {
  return putRecord(KEY_RECORD, { key: record.key, salt: record.salt, iter: record.iter });
}

export function loadKey(): Promise<StoredKey | null> {
  return getRecord<StoredKey>(KEY_RECORD);
}

/** The stored key, but only if it was derived for this file's salt and
 * iteration count. `null` means the passphrase has to be asked for again. */
export async function loadKeyFor(header: Pick<FileHeader, "salt" | "iter">): Promise<CryptoKey | null> {
  const stored = await loadKey();
  if (!stored || stored.salt !== header.salt || stored.iter !== header.iter) return null;
  return stored.key;
}

export function saveConnection(connection: Connection): Promise<void> {
  return putRecord(CONNECTION_RECORD, { ...connection });
}

export function loadConnection(): Promise<Connection | null> {
  return getRecord<Connection>(CONNECTION_RECORD);
}

/** Deletes everything this device keeps for GitHub storage mode: the key and
 * the connection, token included. */
export function forgetDevice(): Promise<void> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new DeviceStoreUnavailableError());
  return new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
