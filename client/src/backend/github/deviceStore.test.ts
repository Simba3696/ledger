import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptDocument, DEFAULT_ITERATIONS, deriveKey, encryptDocument, newSalt, parseHeader } from "../crypto";
import { bytesToBase64 } from "../base64";
import {
  type Connection,
  DeviceStoreUnavailableError,
  forgetDevice,
  loadConnection,
  loadKey,
  loadKeyFor,
  saveConnection,
  saveKey,
} from "./deviceStore";

// fake-indexeddb stores values by structured clone, as a browser does, so a
// CryptoKey comes back as a real (still non-extractable) CryptoKey.

const salt = bytesToBase64(newSalt());
let key: CryptoKey;

beforeAll(async () => {
  key = await deriveKey("correct horse battery staple", salt, DEFAULT_ITERATIONS);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await forgetDevice();
});

const patConnection: Connection = {
  kind: "pat",
  token: "github_pat_11AAAAAAA0example",
  owner: "alex",
  repo: "ledger-data",
  path: "ledger.json.enc",
  login: "alex",
  expiresAt: "2026-12-31T00:00:00.000Z",
};

const appConnection: Connection = {
  kind: "app",
  token: "ghu_exampleUserToken",
  owner: "alex",
  repo: "ledger-data",
  path: "ledger.json.enc",
  login: "alex",
  expiresAt: "2026-10-10T08:00:00.000Z",
  refreshToken: "ghr_exampleRefreshToken",
  refreshTokenExpiresAt: "2027-04-09T00:00:00.000Z",
};

describe("deviceStore", () => {
  it("keeps the key non-extractable, and it still decrypts a file written before the save", async () => {
    const file = await encryptDocument({ remarks: "Groceries test" }, key, { salt, iter: DEFAULT_ITERATIONS });
    await saveKey({ key, salt, iter: DEFAULT_ITERATIONS });

    const stored = await loadKey();
    expect(stored).not.toBeNull();
    expect(stored!.key).toBeInstanceOf(CryptoKey);
    expect(stored!.key.extractable).toBe(false);
    expect(stored!.key.usages.sort()).toEqual(["decrypt", "encrypt"]);
    await expect(crypto.subtle.exportKey("raw", stored!.key)).rejects.toThrow();
    expect(stored).toMatchObject({ salt, iter: DEFAULT_ITERATIONS });
    expect(await decryptDocument(file, stored!.key)).toEqual({ remarks: "Groceries test" });
  });

  it("uses a stored key only for the salt and iter it was derived for", async () => {
    await saveKey({ key, salt, iter: DEFAULT_ITERATIONS });
    const file = await encryptDocument({}, key, { salt, iter: DEFAULT_ITERATIONS });
    expect(await loadKeyFor(parseHeader(file))).toBeInstanceOf(CryptoKey);
    expect(await loadKeyFor({ salt: bytesToBase64(newSalt()), iter: DEFAULT_ITERATIONS })).toBeNull();
    expect(await loadKeyFor({ salt, iter: 700_000 })).toBeNull();
  });

  it("round-trips a pasted-token connection", async () => {
    expect(await loadConnection()).toBeNull();
    await saveConnection(patConnection);
    expect(await loadConnection()).toEqual(patConnection);
  });

  it("round-trips a GitHub App connection with its refresh fields unchanged", async () => {
    await saveConnection(appConnection);
    expect(await loadConnection()).toEqual(appConnection);
  });

  it("forgets the key and the connection", async () => {
    await saveKey({ key, salt, iter: DEFAULT_ITERATIONS });
    await saveConnection(appConnection);
    await forgetDevice();
    expect(await loadKey()).toBeNull();
    expect(await loadConnection()).toBeNull();
  });

  it("rejects every call with DeviceStoreUnavailableError without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    for (const call of [
      () => saveKey({ key, salt, iter: DEFAULT_ITERATIONS }),
      () => loadKey(),
      () => loadKeyFor({ salt, iter: DEFAULT_ITERATIONS }),
      () => saveConnection(patConnection),
      () => loadConnection(),
      () => forgetDevice(),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(DeviceStoreUnavailableError);
    }
  });
});
