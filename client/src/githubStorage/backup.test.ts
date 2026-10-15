import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../backend/base64";
import { DEFAULT_ITERATIONS, deriveKey, newSalt } from "../backend/crypto";
import { createEmptyDocument } from "../backend/document/createDocument";
import { DocumentBackend } from "../backend/document/DocumentBackend";
import type { LedgerDocument } from "../backend/document/types";
import { testKey } from "../backend/sync/localTestkit";
import { seal, type DeviceKey } from "../backend/sync/records";
import { backupFileName, DAMAGED, MAX_BACKUP_BYTES, NEWER, NOT_A_BACKUP, readBackupFile, summarize, TOO_LARGE, WRONG_PASSPHRASE } from "./backup";

// #9's backup files, amended for the redesigned sync: what readBackupFile
// accepts and refuses, and with which key. Fictional data only.

const PASSPHRASE = "correct horse battery staple";
/** A ledger with one expense, made as the app makes one. */
async function ledger(): Promise<LedgerDocument> {
  let current = createEmptyDocument({ modules: ["expenses", "debts"], timeZone: "Asia/Kolkata" });
  const backend = new DocumentBackend({ host: { current: () => current, commit: async (next) => void (current = next) }, now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
  await backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  return current;
}
const file = (text: string | Uint8Array<ArrayBuffer>) => new Blob([text]);

async function householdKey(): Promise<DeviceKey> {
  const salt = bytesToBase64(newSalt());
  return { key: await deriveKey(PASSPHRASE, salt, DEFAULT_ITERATIONS), salt, iter: DEFAULT_ITERATIONS };
}

describe("backup files (#9)", () => {
  it("are named ledger-backup-YYYY-MM-DD.enc by the device's local date", () => {
    expect(backupFileName(new Date(2026, 9, 4))).toBe("ledger-backup-2026-10-04.enc");
  });

  it("this device's key opens a backup sealed under it, with no passphrase asked, and summarises it", async () => {
    const key = await testKey();
    const read = await readBackupFile(file(await seal(await ledger(), key)), key);
    expect(read).toMatchObject({ ok: true, key, summary: { expenses: 1, from: "2026-05", to: "2026-05", debts: 0, emis: 0, subscriptions: 0 } });
  });

  it("a backup under another salt asks for its passphrase, then opens with it; a wrong one says so", async () => {
    const theirs = await householdKey();
    const text = await seal(await ledger(), theirs);
    expect(await readBackupFile(file(text), await testKey())).toEqual({ ok: false, needsPassphrase: true });
    expect(await readBackupFile(file(text), null, "not the passphrase")).toEqual({ ok: false, message: WRONG_PASSPHRASE });
    const read = await readBackupFile(file(text), null, PASSPHRASE);
    expect(read.ok && read.key.salt).toBe(theirs.salt);
  }, 30_000);

  it("refuses what isn't a backup: plain JSON, a PNG, an empty file, a header without its cipher", async () => {
    expect(await readBackupFile(file(JSON.stringify({ version: 1 })), null)).toEqual({ ok: false, message: NOT_A_BACKUP });
    expect(await readBackupFile(file(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null)).toEqual({ ok: false, message: NOT_A_BACKUP });
    expect(await readBackupFile(file(""), null)).toEqual({ ok: false, message: NOT_A_BACKUP });
    const key = await testKey();
    const [header, body] = (await seal(await ledger(), key)).split("\n");
    const noAlg = JSON.parse(header) as Record<string, unknown>;
    delete noAlg.alg;
    expect(await readBackupFile(file(`${JSON.stringify(noAlg)}\n${body}`), key)).toEqual({ ok: false, message: NOT_A_BACKUP });
  });

  it("refuses a file over 25 MB before reading it", async () => {
    const big = { size: MAX_BACKUP_BYTES + 1, text: () => Promise.reject(new Error("read")) } as unknown as Blob;
    expect(await readBackupFile(big, null)).toEqual({ ok: false, message: TOO_LARGE });
  });

  it("says damaged for a body that isn't base64, and for a document missing a part", async () => {
    const key = await testKey();
    const [header] = (await seal(await ledger(), key)).split("\n");
    expect(await readBackupFile(file(`${header}\n!!not base64!!`), key)).toEqual({ ok: false, message: DAMAGED });
    const broken = (await ledger()) as unknown as Record<string, unknown>;
    delete broken.debts;
    expect(await readBackupFile(file(await seal(broken, key)), key)).toEqual({ ok: false, message: DAMAGED });
  });

  it("says a newer version made it, for a newer file format or document version", async () => {
    const key = await testKey();
    const [header, body] = (await seal(await ledger(), key)).split("\n");
    expect(await readBackupFile(file(`${JSON.stringify({ ...JSON.parse(header), v: 2 })}\n${body}`), key)).toEqual({ ok: false, message: NEWER });
    expect(await readBackupFile(file(await seal({ ...(await ledger()), version: 2 }, key)), key)).toEqual({ ok: false, message: NEWER });
  });

  it("summarises an empty ledger", () => {
    expect(summarize(createEmptyDocument({ modules: ["expenses"], timeZone: "UTC" }))).toEqual({ expenses: 0, from: null, to: null, debts: 0, emis: 0, subscriptions: 0 });
  });
});
