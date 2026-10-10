import { isDeviceId, randomHex } from "./tags";

// Epochs as data (design sections 2.1, 6 and 9.1). A restore starts a new
// epoch; the greatest epoch with a listed genesis wins outright, and no clock
// is involved in choosing it.

/** "e", a 6-digit epoch number, "-", 8 random hex digits. */
export function isEpochKey(value: unknown): value is string {
  return typeof value === "string" && /^e\d{6}-[0-9a-f]{8}$/.test(value);
}

function epochNumber(key: string): number {
  return Number(key.slice(1, 7));
}

/** By epoch number, then by the random hex. */
export function compareEpochKeys(a: string, b: string): number {
  return epochNumber(a) - epochNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The key for the epoch after the highest-numbered one listed. */
export function nextEpochKey(highestNumber: number, hex: (count: number) => string = randomHex): string {
  const n = highestNumber + 1;
  if (!Number.isInteger(n) || n < 1 || n > 999999) throw new RangeError(`Epoch number out of range: ${n}`);
  return `e${String(n).padStart(6, "0")}-${hex(4)}`;
}

/** A file in the data repo's ledger/ folder that sync reads. */
export type RepoFile = { kind: "genesis"; epoch: string } | { kind: "log" | "snap"; epoch: string; device: string };

/** `<epochKey>.genesis.enc` or `<epochKey>.<deviceId>.<log|snap>.enc`;
 * null for any other name, which sync ignores. */
export function parseRepoFileName(name: string): RepoFile | null {
  const parts = name.split(".");
  if (parts.at(-1) !== "enc" || !isEpochKey(parts[0])) return null;
  if (parts.length === 3 && parts[1] === "genesis") return { kind: "genesis", epoch: parts[0] };
  if (parts.length === 4 && isDeviceId(parts[1]) && (parts[2] === "log" || parts[2] === "snap")) {
    return { kind: parts[2], epoch: parts[0], device: parts[1] };
  }
  return null;
}

export function repoFileName(file: RepoFile): string {
  return file.kind === "genesis" ? `${file.epoch}.genesis.enc` : `${file.epoch}.${file.device}.${file.kind}.enc`;
}

/** The winning epoch in a listing: the greatest epoch key with a genesis
 * listed. An epoch counts only if its genesis is listed. Null if none is. */
export function winningEpoch(names: readonly string[]): string | null {
  let winner: string | null = null;
  for (const name of names) {
    const file = parseRepoFileName(name);
    if (file?.kind === "genesis" && (winner === null || compareEpochKeys(file.epoch, winner) > 0)) winner = file.epoch;
  }
  return winner;
}

/** What a listing's winner means for a device on epoch `persisted`:
 * "stale" (a listing older than what this device already joined: end the
 * cycle), "same", or "switch" (a restore won: move to it, section 9.3). */
export function epochMove(winner: string, persisted: string): "stale" | "same" | "switch" {
  const order = compareEpochKeys(winner, persisted);
  return order < 0 ? "stale" : order === 0 ? "same" : "switch";
}
