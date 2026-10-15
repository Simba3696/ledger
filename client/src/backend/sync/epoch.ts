import { isDeviceId, randomHex } from "./tags";

// Epochs as data (design sections 2.1, 6 and 9.1). A restore starts a new
// epoch; the greatest counted epoch with a listed genesis wins outright, and
// no clock is involved in choosing it.
//
// A restore must never be refused, so a restore always has a next epoch
// that wins: the number is not capped at 6 digits, and an epoch counts only
// if every number below it, from 1, has a listed genesis too. Honest
// restores add 1 to the winner, so they always extend the run; a genesis
// numbered past a gap is ignored, so no single file can take the number to
// a value whose file names would be too long to write.

/** "e", the epoch number (6 digits zero-padded, or more with no leading
 * zero: one spelling per number), "-", 8 random hex digits. */
export function isEpochKey(value: unknown): value is string {
  return typeof value === "string" && /^e(\d{6}|[1-9]\d{6,})-[0-9a-f]{8}$/.test(value);
}

/** The epoch number's digits, as isEpochKey spells them. */
function epochDigits(key: string): string {
  return key.slice(1, key.indexOf("-"));
}

/** How epoch number `n` is spelled in a key. */
function spellEpoch(n: number): string {
  return String(n).padStart(6, "0");
}

/** By epoch number, then by the random hex. Numbers compare exactly at any
 * length: a longer spelling is a greater number. */
export function compareEpochKeys(a: string, b: string): number {
  const [da, db] = [epochDigits(a), epochDigits(b)];
  if (da.length !== db.length) return da.length - db.length;
  return da < db ? -1 : da > db ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** By epoch number alone: two keys of one number (racing restores) are
 * equal here. */
export function compareEpochNumbers(a: string, b: string): number {
  const [da, db] = [epochDigits(a), epochDigits(b)];
  if (da.length !== db.length) return da.length - db.length;
  return da < db ? -1 : da > db ? 1 : 0;
}

/** The key for a restore's epoch: the one after `winner`, the winning epoch
 * of a fresh listing, or the first epoch when none is listed. */
export function nextEpochKey(winner: string | null, hex: (count: number) => string = randomHex): string {
  // A counted epoch's number is at most the number of genesis files listed,
  // so it is a small safe integer.
  const n = winner === null ? 1 : Number(epochDigits(winner)) + 1;
  if (!Number.isSafeInteger(n)) throw new RangeError(`Epoch number out of range: ${n}`);
  return `e${spellEpoch(n)}-${hex(4)}`;
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

/** The winning epoch in a listing: the greatest counted epoch key. An
 * epoch counts only if its genesis is listed and so is a genesis for every
 * number from 1 up to its own. Null if none counts. */
export function winningEpoch(names: readonly string[]): string | null {
  const byNumber = new Map<string, string>();
  for (const name of names) {
    const file = parseRepoFileName(name);
    if (file?.kind !== "genesis") continue;
    const digits = epochDigits(file.epoch);
    const best = byNumber.get(digits);
    if (best === undefined || compareEpochKeys(file.epoch, best) > 0) byNumber.set(digits, file.epoch);
  }
  let winner: string | null = null;
  for (let n = 1; byNumber.has(spellEpoch(n)); n++) winner = byNumber.get(spellEpoch(n))!;
  return winner;
}

/** Whether `epoch` counts in a listing (`names`): its genesis is listed,
 * and so is a genesis for every number from 1 below it (the counted-run
 * rule winningEpoch applies). A device whose epoch doesn't count in a full
 * listing has lost it: its genesis, or one below it, was deleted. */
export function epochCounted(names: Iterable<string>, epoch: string): boolean {
  const numbers = new Set<string>();
  let listed = false;
  for (const name of names) {
    const file = parseRepoFileName(name);
    if (file?.kind !== "genesis") continue;
    numbers.add(epochDigits(file.epoch));
    if (file.epoch === epoch) listed = true;
  }
  if (!listed) return false;
  const top = Number(epochDigits(epoch));
  if (!(top >= 1)) return false;
  // Ends at the first number missing, so at most one step past the
  // genesis files listed, however long the number is.
  for (let n = 1; n < top; n++) if (!numbers.has(spellEpoch(n))) return false;
  return true;
}

/** Whether a listing (`names`) holds a log or snap file of `epoch`: some
 * device joined that epoch and wrote there. Its genesis is then never one
 * to delete (owner decision D26): that would leave the epoch uncounted and
 * strand every device in it. */
export function epochJoined(names: Iterable<string>, epoch: string): boolean {
  for (const name of names) {
    const file = parseRepoFileName(name);
    if (file !== null && file.kind !== "genesis" && file.epoch === epoch) return true;
  }
  return false;
}

/** What a listing's winner means for a device on epoch `persisted`:
 * "stale" (a listing older than what this device already joined: end the
 * cycle), "same", or "switch" (a restore won: move to it, section 9.3). */
export function epochMove(winner: string, persisted: string): "stale" | "same" | "switch" {
  const order = compareEpochKeys(winner, persisted);
  return order < 0 ? "stale" : order === 0 ? "same" : "switch";
}
