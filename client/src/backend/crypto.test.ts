import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./base64";
import {
  checkEnvironment,
  decryptDocument,
  DEFAULT_ITERATIONS,
  deriveKey,
  encryptDocument,
  InvalidFileError,
  newSalt,
  parseHeader,
  WrongPassphraseError,
} from "./crypto";

// Fictional data only. PBKDF2 at 600,000 iterations takes a few hundred ms,
// so the keys are derived once.

const PASSPHRASE = "correct horse battery staple";
const salt = newSalt();
let key: CryptoKey;
let wrongKey: CryptoKey;

beforeAll(async () => {
  [key, wrongKey] = await Promise.all([
    deriveKey(PASSPHRASE, salt, DEFAULT_ITERATIONS),
    deriveKey("not the passphrase", salt, DEFAULT_ITERATIONS),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CATEGORIES = ["Food", "Transport", "Bills", "Health", "Shopping"];

/** Ten years of fictional entries: 12,000 expenses plus the other lists. */
function tenYearDocument() {
  const expenses = Array.from({ length: 12_000 }, (_, i) => ({
    id: `e-${i.toString(36).padStart(6, "0")}-${(i * 7919).toString(16)}`,
    year: 2017 + Math.floor(i / 1200),
    month: 1 + (Math.floor(i / 100) % 12),
    amount: Math.round(((i * 37) % 5000) + 1) / 10,
    remarks: `Entry ${i} at Shop ${i % 40}`,
    category: CATEGORIES[i % CATEGORIES.length],
    isCard: i % 3 === 0,
    updatedAt: new Date(Date.UTC(2017, 0, 1) + i * 26_280_000).toISOString(),
    updatedBy: "alex",
  }));
  return {
    schemaVersion: 1,
    expenses,
    debts: [{ id: "d-1", name: "Alex", amount: -250 }],
    emis: [{ id: "m-1", cardOrBank: "Car Loan", emiAmount: 300, dueDay: 5, totalAmount: 7200 }],
    cards: [{ id: "c-1", name: "Card A" }],
    tombstones: {},
  };
}

function headerOf(text: string) {
  return JSON.parse(text.slice(0, text.indexOf("\n"))) as Record<string, unknown>;
}

function withHeader(text: string, edit: (header: Record<string, unknown>) => void): string {
  const header = headerOf(text);
  edit(header);
  return `${JSON.stringify(header)}${text.slice(text.indexOf("\n"))}`;
}

describe("encryptDocument / decryptDocument", () => {
  it("round-trips an empty and a 10-year document", async () => {
    expect(await decryptDocument(await encryptDocument({}, key, { salt, iter: DEFAULT_ITERATIONS }), key)).toEqual({});

    const doc = tenYearDocument();
    const t0 = performance.now();
    const text = await encryptDocument(doc, key, { salt, iter: DEFAULT_ITERATIONS });
    const t1 = performance.now();
    const back = await decryptDocument(text, key);
    const t2 = performance.now();
    expect(back).toEqual(doc);
    console.log(
      `10-year document (${doc.expenses.length} expenses): plaintext ${JSON.stringify(doc).length} bytes, ` +
        `encrypted ${text.length} bytes, encrypt ${(t1 - t0).toFixed(0)} ms, decrypt ${(t2 - t1).toFixed(0)} ms`,
    );
  });

  it("writes the header format and no plaintext", async () => {
    const text = await encryptDocument({ remarks: "Groceries test", amount: 42 }, key, { salt, iter: DEFAULT_ITERATIONS });
    expect(() => JSON.parse(text)).toThrow();
    const [headerLine, body, ...rest] = text.split("\n");
    expect(rest).toEqual([]);
    const header = JSON.parse(headerLine);
    expect(Object.keys(header)).toEqual(["v", "kdf", "iter", "salt", "iv", "alg", "z"]);
    expect(header).toMatchObject({ v: 1, kdf: "PBKDF2-SHA256", iter: 600000, alg: "AES-GCM-256", z: "gzip" });
    expect(base64ToBytes(header.salt)).toHaveLength(16);
    expect(base64ToBytes(header.iv)).toHaveLength(12);
    expect(base64ToBytes(header.salt)).toEqual(salt);
    expect(text).not.toContain("Groceries test");
    const ciphertext = String.fromCharCode(...base64ToBytes(body));
    expect(ciphertext).not.toContain("Groceries");
  });

  it("throws WrongPassphraseError for a key from another passphrase", async () => {
    const text = await encryptDocument({ a: 1 }, key, { salt, iter: DEFAULT_ITERATIONS });
    const failure = decryptDocument(text, wrongKey);
    await expect(failure).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(failure).rejects.toThrow(/^Wrong passphrase$/);
  });

  it("fails when any byte of the header line changes", async () => {
    const text = await encryptDocument({ remarks: "Groceries test" }, key, { salt, iter: DEFAULT_ITERATIONS });
    const iterBumped = withHeader(text, (h) => (h.iter = 600001));
    await expect(decryptDocument(iterBumped, key)).rejects.toBeInstanceOf(WrongPassphraseError);

    const headerLength = text.indexOf("\n");
    for (let i = 0; i < headerLength; i++) {
      const swapped = text[i] === "A" ? "B" : "A";
      const tampered = text.slice(0, i) + swapped + text.slice(i + 1);
      await expect(decryptDocument(tampered, key), `byte ${i}`).rejects.toThrow();
    }
  });

  it("parseHeader rejects weak or unknown headers", async () => {
    const text = await encryptDocument({}, key, { salt, iter: DEFAULT_ITERATIONS });
    expect(parseHeader(text)).toMatchObject({ v: 1, iter: 600000 });
    const bad = [
      withHeader(text, (h) => (h.iter = 599999)),
      withHeader(text, (h) => (h.iter = 10_000_001)),
      withHeader(text, (h) => (h.iter = "600000")),
      withHeader(text, (h) => (h.alg = "AES-CBC-256")),
      withHeader(text, (h) => (h.kdf = "scrypt")),
      withHeader(text, (h) => (h.z = "none")),
      withHeader(text, (h) => (h.v = 2)),
      withHeader(text, (h) => delete h.salt),
      withHeader(text, (h) => (h.salt = "c2hvcnQ=")),
      withHeader(text, (h) => (h.iv = "c2hvcnQ=")),
      withHeader(text, (h) => (h.iv = "!!not base64!!")),
      "not json\nAAAA",
      "no newline at all",
    ];
    for (const file of bad) {
      expect(() => parseHeader(file), file.slice(0, 60)).toThrow(InvalidFileError);
      await expect(decryptDocument(file, key)).rejects.toBeInstanceOf(InvalidFileError);
    }
  });

  it("throws InvalidFileError for a body that decrypts but isn't gzip, and for one that inflates past maxPlainBytes", async () => {
    const sealed = async (plain: Uint8Array<ArrayBuffer>) => {
      const header = headerOf(await encryptDocument({}, key, { salt, iter: DEFAULT_ITERATIONS }));
      const headerLine = JSON.stringify(header);
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: base64ToBytes(header.iv as string), additionalData: new TextEncoder().encode(headerLine) }, key, plain);
      return `${headerLine}
${bytesToBase64(new Uint8Array(cipher))}`;
    };
    await expect(decryptDocument(await sealed(new TextEncoder().encode('{"a":1}')), key)).rejects.toBeInstanceOf(InvalidFileError);

    const text = await encryptDocument({ remarks: " ".repeat(4096) }, key, { salt, iter: DEFAULT_ITERATIONS });
    expect(text.length).toBeLessThan(1024);
    await expect(decryptDocument(text, key, { maxPlainBytes: 4096 })).rejects.toBeInstanceOf(InvalidFileError);
    expect(await decryptDocument(text, key, { maxPlainBytes: 4200 })).toEqual({ remarks: " ".repeat(4096) });
  });

  it("uses a fresh IV for every encryption", async () => {
    const doc = { remarks: "Same document" };
    const a = await encryptDocument(doc, key, { salt, iter: DEFAULT_ITERATIONS });
    const b = await encryptDocument(doc, key, { salt, iter: DEFAULT_ITERATIONS });
    expect(headerOf(a).iv).not.toBe(headerOf(b).iv);
    expect(a.split("\n")[1]).not.toBe(b.split("\n")[1]);
    expect(await decryptDocument(a, key)).toEqual(await decryptDocument(b, key));
  });

  it("re-encrypts with the salt and iter read from an existing header", async () => {
    const otherSalt = newSalt();
    const existing = await encryptDocument({ n: 1 }, key, { salt: otherSalt, iter: 700_000 });
    const header = parseHeader(existing);
    expect(header.iter).toBe(700000);

    const rewritten = await encryptDocument({ n: 2 }, key, { salt: header.salt, iter: header.iter });
    const next = parseHeader(rewritten);
    expect(next.salt).toBe(header.salt);
    expect(next.iter).toBe(700000);
    expect(next.iv).not.toBe(header.iv);
    expect(await decryptDocument(rewritten, key)).toEqual({ n: 2 });
  });
});

describe("checkEnvironment", () => {
  it("fails as insecure-context without crypto.subtle or a secure context", () => {
    const expected = {
      ok: false,
      reason: "insecure-context",
      message: "Ledger needs a secure (HTTPS) address to encrypt your data. Open it from an https:// link.",
    };
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(checkEnvironment()).toEqual(expected);
    vi.unstubAllGlobals();

    vi.stubGlobal("isSecureContext", false);
    expect(checkEnvironment()).toEqual(expected);
  });

  it("fails as no-compression-stream without CompressionStream", () => {
    vi.stubGlobal("CompressionStream", undefined);
    expect(checkEnvironment()).toMatchObject({ ok: false, reason: "no-compression-stream" });
  });

  it("fails as no-web-locks without navigator.locks (Safari before 15.4)", () => {
    vi.stubGlobal("navigator", {});
    expect(checkEnvironment()).toMatchObject({ ok: false, reason: "no-web-locks" });
  });

  it("only warns without IndexedDB", () => {
    vi.stubGlobal("navigator", { locks: { request: () => Promise.resolve() } });
    vi.stubGlobal("indexedDB", undefined);
    expect(checkEnvironment()).toEqual({ ok: true, warnings: ["no-indexeddb"] });
    vi.stubGlobal("indexedDB", {});
    expect(checkEnvironment()).toEqual({ ok: true, warnings: [] });
  });
});

describe("Node import", () => {
  it("imports and round-trips with no DOM, window or IndexedDB", async () => {
    // Plain Node 22 globals (vitest's node environment, no DOM shim), with
    // tripwires: touching any browser-only global fails the test.
    for (const name of ["window", "document", "indexedDB", "localStorage", "self"]) {
      expect(name in globalThis, name).toBe(false);
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error(`crypto.ts touched ${name}`);
        },
      });
    }
    try {
      vi.resetModules();
      const fresh = await import("./crypto");
      const nodeSalt = fresh.newSalt();
      const nodeKey = await fresh.deriveKey(PASSPHRASE, nodeSalt, fresh.DEFAULT_ITERATIONS);
      const doc = { expenses: [{ remarks: "Groceries test", amount: 12.5 }] };
      const text = await fresh.encryptDocument(doc, nodeKey, { salt: nodeSalt, iter: fresh.DEFAULT_ITERATIONS });
      expect(await fresh.decryptDocument(text, nodeKey)).toEqual(doc);
    } finally {
      for (const name of ["window", "document", "indexedDB", "localStorage", "self"]) {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });
});
