import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { bytesToBase64 } from "../base64";
import { DEFAULT_ITERATIONS } from "../crypto";
import { DocumentBackend } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import { GitHubError, createGitHubClient, type GitHubClient } from "../github/contents";
import { createFakeGitHub, type FakeGitHub } from "../github/fakeGitHub";
import { FORMAT_VERSION } from "./codec";
import { MemoryStore, nextTask } from "./cycleTestkit";
import { findLedger, openGenesis } from "./ledgerRepo";
import type { LeftBehindItem, ReapplyResult } from "./leftBehind";
import { documentOf, documentText, fold, holds, holdsIn, obligations, plainText, readHistory, snapshotWrites, winnerOf, writesOf, type Obligation, type OracleOp, type RepoHistory } from "./oracle";
import { WriterTokenMismatch, type SyncStore } from "./persist";
import { seal, unseal, type DeviceKey, type SyncMeta } from "./records";
import { genesisState, type Op, type SyncState } from "./state";
import { DEVICE_SAVE_FAILED, SyncEngine, type LeftBehindView } from "./SyncEngine";
import { MAX_L } from "./tags";
import { SyncedHost } from "./SyncedHost";
import { ALL_MODULES, Replica, Rng, emptyDocument, testEnv } from "./testkit";

// The property harness (design section 16.4, acceptance items 5 and 6;
// stage 8a). Seeded random schedules of 2-4 devices, each a real SyncEngine
// with a real DocumentBackend over SyncedHost and its own device store and
// skewed, jumping clock, sharing one fake GitHub. A schedule mixes every
// LedgerBackend call (17 writes, 14 reads) and #8's settings write; notice
// actions and dismissals; offline spells; lost, late and duplicated PUT
// responses; 409, 422, 5xx, 401 and rate-limit answers; stale reads and cut
// listings; reloads at rest, mid-commit and mid-cycle; device-store
// failures; compaction and snapshots; a stale-UI fence that lags; a cloned
// profile (a fork, then a rehome); a device joining late; restores (often
// of a backup taken while a device had changes not yet synced), racing
// restores (often followed by another), re-apply and discard.
//
// After quiescence (faults healed, every device cycled until two rounds
// change nothing) it checks against oracle.ts, an implementation written
// apart from the engine:
//   - every device's document equals the oracle's fold of every op that
//     reached the winning epoch's logs, over its genesis (no loss, nothing
//     invented: AC5, AC6);
//   - every op a device committed in the winning epoch reached the repo
//     (exactly, or, for a cloned id, re-issued by its rehome);
//   - a re-apply puts in effect at once every item it says it applied, or
//     the fence's notice tells why not, and skips an item only for a reason
//     that holds (section 9.4);
//   - every change made in an earlier epoch that the winning restore left
//     out is still offered on the device that made it, or is in effect, or
//     was held by a restore in the winner's line it switched to, or was
//     re-applied, or was discarded or skipped (with its reason) by that
//     device in the winner's line, item by item, or was replaced by its own
//     device's restore (AC6, AC13, D18);
//   - nothing invented: every snapshot write is one an op or a genesis
//     made, and every offered left-behind change is a write by that group's
//     device in that epoch above the cut the winner's line left it behind
//     with (nothing the winner already holds is offered);
//   - no file written but a device's own (AC10), nothing in plaintext
//     (AC15), no (device, L) published twice with two contents except by a
//     cloned id that then rehomed, and an idle round of one request and no
//     PUT per device (AC9);
//   - no device is blocked: each is idle with nothing pending, and a new
//     write on each one syncs everywhere.
//
// LEDGER_HARNESS_SEEDS (default 40), LEDGER_HARNESS_STEPS (default 100) and
// LEDGER_HARNESS_FIRST (the first seed, default 1) size a run;
// LEDGER_HARNESS_SEED replays one seed. A failure names its seed;
// LEDGER_HARNESS_KEEP_GOING=1 runs every seed and lists every failure;
// LEDGER_HARNESS_TRACE=1 adds each request and its answer to the log a
// stuck run prints. Device
// ids, record ids, epoch keys and IVs come from the seed, so a replay takes
// the same path, short of the order in which concurrent crypto settles.
// Fictional data only.

const SEEDS = Number(testEnv("LEDGER_HARNESS_SEEDS") ?? 40);
const STEPS = Number(testEnv("LEDGER_HARNESS_STEPS") ?? 100);
const FIRST = Number(testEnv("LEDGER_HARNESS_FIRST") ?? 1);
const ONLY = testEnv("LEDGER_HARNESS_SEED");
/** Run every seed and list every failure, for a deep run. */
const KEEP_GOING = testEnv("LEDGER_HARNESS_KEEP_GOING") === "1";
/** How often a restore that doesn't race is followed, a few steps later,
 * by a racing pair (default 0, the schedule seeds were tuned with): what a
 * genesis held back is owed again only when a later race leaves that
 * genesis out (#14). */
const RACE_AFTER = Number(testEnv("LEDGER_HARNESS_RACE_AFTER") ?? 0);
/** Every engine a seed started, stopped once it ends, passed or not. */
const started: SyncEngine[] = [];

const OWNER = "alex";
const REPO = "ledger-data";
const FULL = `${OWNER}/${REPO}`;
const DAY = 86_400_000;
/** A device with no engine whose op starts a run near the top of the
 * Lamport range, in that share of runs. */
const PHANTOM = "d00000000000000aa";
const TRACE = testEnv("LEDGER_HARNESS_TRACE") === "1";
const LAMPORT_TOP = Number(testEnv("LEDGER_HARNESS_LAMPORT_TOP") ?? 0.15);
/** Texts no repo file or saved meta may hold in plaintext (AC15). Each has
 * a space, which base64 never holds, so a match is never by chance. */
const REMARKS = ["Groceries run", "Bus ticket", "Rent payment", "Tea shop"];

/** What a schedule exercised, summed over seeds, so a run can't pass by
 * doing nothing. */
const counts = {
  steps: 0,
  nearTop: 0,
  writes: 0,
  refused: 0,
  reads: 0,
  cycles: 0,
  faults: 0,
  reloads: 0,
  midCommit: 0,
  restores: 0,
  racing: 0,
  switches: 0,
  forks: 0,
  rehomes: 0,
  joins: 0,
  notices: 0,
  told: 0,
  actions: 0,
  reapplied: 0,
  discarded: 0,
  snapshots: 0,
  obligations: 0,
  offered: 0,
  reappliedOb: 0,
  /** Switches that held back parts a new genesis held, and parts offered
   * again because that genesis lost (#14). */
  heldBack: 0,
  offeredAgain: 0,
  superseded: 0,
};

/** One physical device: its engines over time (reloads), the stores it has
 * used (a restore's reload starts a new one), and what the person did on
 * it that settles changes a restore left behind. */
interface Slot {
  name: string;
  login: string;
  engine: SyncEngine;
  backend: DocumentBackend;
  store: MemoryStore;
  stores: MemoryStore[];
  life: { dead: boolean };
  offline: boolean;
  /** Its wall clock's offset from the world's. */
  skew: number;
  compaction: { logOps: number; tailEntries: number } | undefined;
  /** The fence's view lags (rendered() not called). */
  lag: boolean;
  /** Left-behind markers this device re-applied or discarded (for the
   * failure story). */
  resolved: Set<string>;
  /** What this device did with each change a group showed, by
   * "<marker>|<change text>": re-applied (an item the re-apply result
   * lists as applied, checked in effect or told at once), skipped (an item
   * it lists as skipped, its reason checked true then: the person was
   * told why, section 9.4) or discarded (an item the group showed when
   * discarded), and the epoch it did it in: every time it did, as a group
   * resolved in an epoch that then lost is offered again (D18), and may be
   * resolved again elsewhere (#17). */
  settled: Map<string, { how: "applied" | "skipped" | "discarded"; epoch: string }[]>;
  /** Restores this device made: the new epoch, and the epoch and id it
   * restored from. */
  restored: { epoch: string; from: string; device: string }[];
  /** The epoch it was in when it restored with "Restore anyway", which
   * discards its own changes not yet synced and its own groups. */
  discardedAt: string[];
  /** Every epoch it has been in, in order. */
  epochs: string[];
}

interface Harness {
  rng: Rng;
  fake: FakeGitHub;
  key: DeviceKey;
  clock: { wall: number; mono: number };
  slots: Slot[];
  /** Documents a restore may be made from: earlier states of devices. */
  backups: LedgerDocument[];
  /** Work left running by a reload mid-commit or mid-cycle. */
  floating: Promise<unknown>[];
  /** A device-store failure was injected and may not have been met yet. */
  storeFaults: number;
  log: string[];
}

/** Replaces the platform's randomness with the seed's: device ids, record
 * ids, epoch keys, writer tokens and IVs. */
function seedCrypto(seed: number): void {
  const rng = new Rng(seed ^ 0x5bd1e995);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = rng.int(256);
    }
    return array;
  });
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`);
}

async function seededKey(rng: Rng): Promise<DeviceKey> {
  const raw = Uint8Array.from({ length: 32 }, () => rng.int(256));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { key, salt: bytesToBase64(Uint8Array.from({ length: 16 }, () => rng.int(256))), iter: DEFAULT_ITERATIONS };
}

/** The ledger every run starts from: a few rows of every kind, written
 * through a backend. */
async function startingDocument(rng: Rng): Promise<LedgerDocument> {
  const g = new Replica("d00000000000000ff", emptyDocument(), { actor: "alex", newId: () => rng.uuid() });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 15, remarks: "Bus", category: "transportation", isCard: false });
  await g.backend.addDebt({ name: "Sam", amount: 500 });
  await g.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null });
  await g.backend.addSubscription({ service: "Music", amount: 199, duration: "Monthly", expiryAnchor: "2026-05-20", cardOrBank: "Card A" });
  await g.backend.setMonthIncome(2026, 5, { salary: 50000, otherIncome: null, savings: [] });
  return g.doc;
}

function client(h: Harness, slot: Pick<Slot, "login" | "offline">, life: { dead: boolean }, engine: () => SyncEngine | null): GitHubClient {
  const fetchFn: typeof fetch = (input, init) => {
    if (life.dead || slot.offline) return Promise.reject(new TypeError("Failed to fetch"));
    const p = h.fake.fetchAs(engine()?.deviceId ?? "dnone")(input, init);
    if (TRACE) void p.then((r) => h.log.push(`${engine()?.deviceId} ${init?.method ?? "GET"} ${String(input).replace(/.*ledger-data/, "")} -> ${r.status}`), (e: unknown) => h.log.push(`${engine()?.deviceId} ${init?.method ?? "GET"} ${String(input).replace(/.*ledger-data/, "")} -> ${String(e)}`));
    return p;
  };
  return createGitHubClient({ owner: OWNER, repo: REPO, token: `github_pat_${slot.login}`, fetch: fetchFn });
}

/** Starts an engine for `slot` over `store`. A first start begins from
 * `init`. The store is gated: once this engine's page is gone (a reload),
 * nothing it still runs reaches the store or the network. */
async function open(h: Harness, slot: Slot, store: MemoryStore, init?: { epoch: string; state: SyncState }): Promise<void> {
  const life = { dead: false };
  let engine: SyncEngine | null = null;
  const gate: SyncStore = {
    load: () => store.load(),
    chainEntry: (L) => store.chainEntry(L),
    startNewGeneration: () => store.startNewGeneration(),
    volatile: () => store.volatile(),
    mutate: (m) => (life.dead ? Promise.reject(new WriterTokenMismatch("this page was reloaded")) : store.mutate(m)),
  };
  engine = new SyncEngine({
    key: h.key,
    actor: slot.login,
    store: gate,
    locks: null,
    log: (level, message, err) => h.log.push(`${slot.name}: ${level}: ${message}${err ? ` (${err instanceof Error ? err.message : String(err)})` : ""}`),
    remote: { client: client(h, slot, life, () => engine), branch: "main" },
    events: {},
    random: () => 0.5,
    sleep: async () => {},
    monotonic: () => h.clock.mono,
    now: () => h.clock.wall + slot.skew,
    ...(slot.compaction ? { compaction: slot.compaction } : {}),
  });
  started.push(engine);
  await engine.start();
  if (engine.getState().needsInit) {
    if (!init) throw new Error(`${slot.name} has no saved state to load`);
    await engine.initialize(init.epoch, init.state);
  }
  const rng = h.rng;
  slot.engine = engine;
  // Every epoch it is in, however it got there (a switch inside a restore's
  // own sync, or a write's next epoch, included).
  const live = engine;
  live.subscribe(() => {
    if (slot.engine === live) noteEpoch(slot);
  });
  slot.backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => h.clock.wall + slot.skew, actor: slot.login, newId: () => crypto.randomUUID() });
  slot.store = store;
  if (!slot.stores.includes(store)) slot.stores.push(store);
  slot.life = life;
  // The view: SyncHost attaches once it shows the document, then reports
  // each render; a lagging view leaves later joins unrendered (section 3.4).
  engine.attachView(engine.getState().revision);
  slot.lag = rng.chance(0.15);
  noteEpoch(slot);
}

function noteEpoch(slot: Slot): void {
  const epoch = slot.engine.epochKey;
  if (epoch !== null && slot.epochs.at(-1) !== epoch) slot.epochs.push(epoch);
}

function newSlot(name: string, login: string, rng: Rng): Slot {
  return {
    name,
    login,
    engine: null as unknown as SyncEngine,
    backend: null as unknown as DocumentBackend,
    store: null as unknown as MemoryStore,
    stores: [],
    life: { dead: false },
    offline: false,
    skew: (rng.int(61) - 30) * DAY,
    compaction: rng.chance(0.6) ? { logOps: 3 + rng.int(5), tailEntries: 4 + rng.int(8) } : undefined,
    lag: false,
    resolved: new Set(),
    settled: new Map(),
    restored: [],
    discardedAt: [],
    epochs: [],
  };
}

/** A reload: this page is gone, and the device opens again from its store. */
async function reload(h: Harness, slot: Slot): Promise<void> {
  slot.life.dead = true;
  slot.engine.stop();
  counts.reloads++;
  await open(h, slot, slot.store);
}

/** After a restore landed (section 9.2 step 7): the device's sync state is
 * cleared and the page reloads, joining the winning epoch afresh as #8's
 * join does. False when no ledger can be found just now. */
async function rejoin(h: Harness, slot: Slot): Promise<boolean> {
  const init = await find(h, slot);
  if (!init) return false;
  slot.life.dead = true;
  slot.engine.stop();
  await open(h, slot, new MemoryStore(), init);
  return true;
}

/** #8's join: list the repo, open the winning genesis. Null when that
 * can't be done just now (offline, a cut listing, a fault). */
async function find(h: Harness, slot: Pick<Slot, "login" | "offline">): Promise<{ epoch: string; state: SyncState } | null> {
  try {
    const found = await findLedger({ client: client(h, slot, { dead: false }, () => null), branch: "main" });
    if (found.kind !== "ledger") return null;
    const opened = await openGenesis(found, h.key);
    return opened.ok ? { epoch: opened.epoch, state: opened.state } : null;
  } catch (err) {
    if (err instanceof GitHubError) return null;
    throw err;
  }
}

/** Lets in-flight work run for `n` turns of the event loop. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextTask();
}

/** One sync cycle on `slot`, past the PUT spacing. */
async function cycle(h: Harness, slot: Slot): Promise<void> {
  h.clock.mono += 30_000;
  await slot.engine.sync();
  counts.cycles++;
  noteEpoch(slot);
  if (slot.engine.getState().restore?.state === "landed") await rejoin(h, slot);
}

function render(slot: Slot): void {
  if (!slot.lag) slot.engine.rendered(slot.engine.getState().revision);
}

/** An ApiError the schedule may meet: a refusal at the origin, a write
 * refused while a restore runs, or a device-store failure that was
 * injected (or a reload that cut the write off). Anything else, a 500
 * above all, is a bug. */
function expectedRefusal(h: Harness, err: unknown, cutOff = false): void {
  if (!(err instanceof ApiError)) throw err;
  if (err.status !== 500) return;
  if (err.message === DEVICE_SAVE_FAILED && (h.storeFaults > 0 || cutOff)) return;
  if (cutOff) return;
  throw err;
}

// --- The calls --------------------------------------------------------------------

/** One random LedgerBackend call (any of the 31) or #8's settings write,
 * against random existing rows. Refusals at the origin are part of it. */
async function randomCall(h: Harness, slot: Slot, rng: Rng): Promise<void> {
  const b = slot.backend;
  const month = rng.pick([5, 6]);
  const amount = () => rng.pick([10, 12, 40, 99.5]);
  const entry = () => ({ amount: amount(), remarks: rng.pick(REMARKS), category: rng.pick(["food", "transportation", "rent"]), isCard: rng.chance(0.3) });
  const row = async (rows: Promise<{ row: number }[]>) => {
    const list = await rows;
    return list.length > 0 ? rng.pick(list).row : 999;
  };
  const emi = () => ({ cardOrBank: rng.pick(["Car Loan", "Bank B"]), emiAmount: rng.pick([500, 1000]), dueDay: rng.pick([5, 20]), totalAmount: 12000, remarks: rng.pick(["", "x"]), remainingAsOf: rng.pick([9000, 8000]), interestRate: rng.pick([9.5, null]), foreclosureCharge: null, durationMonths: rng.pick([null, 12]) });
  const sub = () => ({ service: rng.pick(["Music", "Video"]), amount: rng.pick([199, 499]), duration: rng.pick(["Monthly", "Yearly"] as const), expiryAnchor: rng.pick(["2026-05-20", "2026-06-01"]), cardOrBank: "Card A" });
  const read = rng.chance(0.15);
  try {
    if (read) {
      counts.reads++;
      switch (rng.int(14)) {
        case 0: await b.getConfig(); break;
        case 1: await b.getCategories(); break;
        case 2: await b.getMonth(2026, month); break;
        case 3: await b.getMonthLock(2026, month); break;
        case 4: await b.getYearSummary(2026); break;
        case 5: await b.getMonthIncome(2026, month); break;
        case 6: await b.getFinanceSummary(2026); break;
        case 7: await b.getDebts(); break;
        case 8: await b.getMonthBills(2026, month); break;
        case 9: await b.getCreditCardBillsSummary(2026); break;
        case 10: await b.getEmis(); break;
        case 11: await b.getEmiMonthlyProjection(rng.pick([6, 12, "auto"] as const)); break;
        case 12: await b.getSubscriptions(); break;
        default: await b.getOverview();
      }
      return;
    }
    counts.writes++;
    switch (rng.int(19)) {
      case 0:
      case 1: await b.addEntry({ year: 2026, month, ...entry() }); break;
      case 2: await b.updateEntry(2026, month, await row(b.getMonth(2026, month)), entry()); break;
      case 3: await b.deleteEntry(2026, month, await row(b.getMonth(2026, month))); break;
      case 4: await b.moveEntry(2026, month, await row(b.getMonth(2026, month)), await row(b.getMonth(2026, month))); break;
      case 5: await b.setMonthLock(2026, month, rng.chance(0.4)); break;
      case 6: await b.setMonthIncome(2026, month, { salary: rng.pick([null, 50000, 52000]), otherIncome: rng.pick([null, 10]), savings: rng.chance(0.5) ? [] : [{ name: "Fund A", amount: amount() }] }); break;
      case 7: await b.addDebt({ name: rng.pick(["Sam", "Alex"]), amount: amount() }); break;
      case 8: await b.updateDebt(await row(b.getDebts()), { name: rng.pick(["Sam", "Alex"]), amount: amount() }); break;
      case 9: await b.deleteDebt(await row(b.getDebts())); break;
      case 10: await b.setMonthBills(2026, month, rng.shuffle(["Card A", "Card B"]).slice(0, rng.int(3)).map((name) => ({ name, due: amount(), paid: rng.pick([0, 10]), dueDate: rng.pick([null, "2026-06-25"]), settled: rng.chance(0.3) }))); break;
      case 11: await b.addEmi(emi()); break;
      case 12: await b.updateEmi(await row(b.getEmis()), emi()); break;
      case 13: await b.payEmi(await row(b.getEmis()), rng.pick([500, 1000])); break;
      case 14: await b.deleteEmi(await row(b.getEmis())); break;
      case 15: await b.addSubscription(sub()); break;
      case 16: await b.updateSubscription(await row(b.getSubscriptions()), sub()); break;
      case 17: await b.deleteSubscription(await row(b.getSubscriptions())); break;
      default:
        // #8's updateSettings: a section switched, or the time zone.
        await slot.engine.amend((doc) => {
          if (rng.chance(0.5)) doc.settings.timeZone = rng.pick(["UTC", "Asia/Kolkata"]);
          else doc.settings.modules = ALL_MODULES.filter((m) => m === "expenses" || rng.chance(0.8));
        });
    }
  } catch (err) {
    counts.refused++;
    expectedRefusal(h, err);
  }
}

/** A notice's action, or a dismissal (section 4.1). */
async function noticeStep(h: Harness, slot: Slot, rng: Rng): Promise<void> {
  const views = slot.engine.notices();
  if (views.length === 0) return;
  counts.notices += views.length;
  const view = rng.pick(views);
  try {
    if (rng.chance(0.25) || view.actions.length === 0) {
      await slot.engine.dismissNotice(view.key);
      return;
    }
    const action = rng.pick(view.actions);
    counts.actions++;
    await slot.engine.noticeAction(view.key, action.kind, rng.chance(0.7) ? { writes: action.writes, paid: action.paid } : undefined);
  } catch (err) {
    expectedRefusal(h, err);
  }
}

/** Re-apply or discard one group a restore left behind (section 9.4). A
 * re-apply must have put in effect every item it says it applied, or told
 * the fence's notice for it, at once, and skipped each other item for a
 * reason that held; it settles those items alone. A discard settles the
 * items the group showed. */
async function leftBehindStep(h: Harness, slot: Slot, rng: Rng): Promise<void> {
  const groups = slot.engine.leftBehind();
  if (groups.length === 0) return;
  const group = rng.pick(groups);
  try {
    if (rng.chance(0.7)) {
      slot.engine.previewReapply(group.id);
      // The person presses Re-apply on the list they see.
      render(slot);
      const before = new Set(slot.engine.notices().map((n) => n.key));
      const was = structuredClone(slot.engine.current());
      const result = await slot.engine.reapply(group.id);
      counts.reapplied++;
      expectInEffect(slot, group.id, result, before);
      expectSkippedRightly(slot, group.id, result, was);
      const epoch = slot.engine.epochKey!;
      for (const item of result.applied) for (const text of itemTexts(item)) settle(slot, `${group.id}|${text}`, "applied", epoch);
      for (const { item } of result.skipped) for (const text of itemTexts(item)) settle(slot, `${group.id}|${text}`, "skipped", epoch);
    } else {
      const shown = group.items.flatMap(itemTexts);
      await slot.engine.discard(group.id);
      counts.discarded++;
      for (const text of shown) settle(slot, `${group.id}|${text}`, "discarded", slot.engine.epochKey!);
    }
    slot.resolved.add(group.id);
  } catch (err) {
    expectedRefusal(h, err);
  }
}

/** Notes what `slot` did with one change a group showed, beside anything
 * it did with it before. */
function settle(slot: Slot, key: string, how: "applied" | "skipped" | "discarded", epoch: string): void {
  slot.settled.set(key, [...(slot.settled.get(key) ?? []), { how, epoch }]);
}

/** A record in `doc`, by collection and id. */
function recordIn(doc: LedgerDocument, coll: string, id: string): Record<string, unknown> | undefined {
  const records = (coll === "e" ? Object.values(doc.expenses).flat() : doc[({ debt: "debts", emi: "emis", sub: "subscriptions" } as const)[coll as "debt" | "emi" | "sub"]]) as unknown as ({ id: string } & Record<string, unknown>)[];
  return records.find((r) => r.id === id);
}

const MODULE_OF: Record<string, string> = { e: "expenses", debt: "debts", emi: "emi", sub: "subscriptions", fm: "finances", cb: "credit-cards", lk: "expenses" };

/** Each item a re-apply skipped, for a reason that held in `was`, the
 * document it ran against: its module off, its month locked, or its record
 * not there. */
function expectSkippedRightly(slot: Slot, marker: string, result: ReapplyResult, was: LedgerDocument): void {
  for (const { item, reason } of result.skipped) {
    const coll = item.kind === "unit" ? item.key.slice(0, item.key.indexOf("/")) : item.coll;
    const record = item.kind === "unit" ? undefined : recordIn(was, item.coll, item.id);
    const month = item.kind === "add" ? item.month : item.kind !== "unit" && item.coll === "e" ? Object.entries(was.expenses).find(([, rs]) => rs.some((r) => r.id === item.id))?.[0] : undefined;
    const holds =
      reason === "moduleOff" ? !(was.settings.modules as string[]).includes(MODULE_OF[coll]) : reason === "monthLocked" ? month !== undefined && was.monthLocks[month] === true : item.kind !== "unit" && record === undefined;
    if (!holds) throw new Error(`re-apply of ${marker} on ${slot.name} skipped ${itemTexts(item).join(", ")} as ${reason}, which isn't so`);
  }
}

/** A unit's value as the document reads it. */
function unitIn(doc: LedgerDocument, key: string): unknown {
  const [family, month] = key.split("/");
  if (family === "lk") return doc.monthLocks[month] === true;
  if (family === "fm") return doc.financeMonths[month] ?? null;
  if (family === "cb") return doc.cardBills[month] ?? null;
  if (key === "st/modules") return doc.settings.modules;
  if (key === "st/timeZone") return doc.settings.timeZone;
  throw new Error(`no unit ${key}`);
}

/** Right after a re-apply: each item it says it applied is in effect in
 * the document, or each register of it not in effect is named in a notice
 * the re-apply raised (the fence kept the value the view showed, section
 * 3.4). A delete is never fenced. */
function expectInEffect(slot: Slot, marker: string, result: ReapplyResult, before: Set<string>): void {
  const doc = slot.engine.current();
  const told = new Set(
    slot.engine
      .notices()
      .filter((n) => !before.has(n.key))
      .flatMap((n) => ("registers" in n.notice ? n.notice.registers.map((r) => r.key) : n.notice.kind === "deleted" ? [`${n.notice.target.coll}/${n.notice.target.id}`] : [])),
  );
  for (const item of result.applied) {
    let missing: string[];
    if (item.kind === "unit") missing = plainText(unitIn(doc, item.key)) === plainText(item.key.startsWith("lk/") ? item.value === true : item.value) || told.has(item.key) ? [] : [item.key];
    else {
      const record = recordIn(doc, item.coll, item.id);
      if (item.kind === "delete") missing = record === undefined ? [] : [`${item.coll}/${item.id}`];
      // A delete joined while the re-apply saved removed the record: it is
      // told by a "deleted" notice (section 4.2 rule 2), Add it back.
      else if (record === undefined) missing = told.has(`${item.coll}/${item.id}`) ? [] : [`${item.coll}/${item.id}`];
      else missing = Object.entries(item.fields).filter(([field, value]) => plainText(record[field]) !== plainText(value) && !told.has(`${item.coll}/${item.id}/${field}`)).map(([field]) => `${item.coll}/${item.id}/${field}`);
    }
    if (missing.length > 0) throw new Error(`re-apply of ${marker} on ${slot.name} says ${itemTexts(item).join(", ")} applied, but ${missing.join(", ")} is neither in effect nor told`);
  }
}

/** One fault on the next matching request (section 12). */
function fault(h: Harness, rng: Rng): void {
  counts.faults++;
  const f = h.fake;
  switch (rng.int(12)) {
    case 0: f.landThenDropResponse({ method: "PUT" }); break;
    case 1: f.landLater(1 + rng.int(6), { method: "PUT" }); break;
    case 2: f.duplicateRequest({ method: "PUT" }); break;
    case 3: f.failNext({ method: "PUT", status: rng.pick([409, 422] as const) }); break;
    case 4: f.failNext({ method: "PUT", status: 500 }); break;
    case 5: f.failNext({ network: true }); break;
    case 6: f.failNext({ method: "GET", status: rng.pick([500, 404] as const), path: /\/git\/blobs\// }); break;
    case 7: f.failNext({ status: 403, rateLimit: rng.pick(["primary", "secondary"] as const) }); break;
    case 8: f.failNext({ status: 401 }); break;
    case 9: f.failNext({ method: "GET", network: true, path: /\/git\/trees\// }); break;
    case 10: f.landThenDropResponse({ method: "GET" }); break;
    default: f.failNext({ status: 429, rateLimit: "secondary" });
  }
}

/** A restore (section 9.2) by `slot` from a backup, and what follows it. */
async function restoreBy(h: Harness, slots: Slot[], rng: Rng): Promise<void> {
  counts.restores++;
  if (slots.length > 1) counts.racing++;
  const runs = slots.map(async (slot) => {
    noteEpoch(slot);
    const from = { epoch: slot.engine.epochKey!, device: slot.engine.deviceId! };
    const discard = rng.chance(0.6);
    // Often the latest backup: one taken while a device still had changes
    // it hadn't synced, whose restore leaves the most behind (stage 8a).
    const backup = structuredClone(rng.chance(0.5) ? h.backups.at(-1)! : rng.pick(h.backups));
    let result: Awaited<ReturnType<SyncEngine["restore"]>>;
    try {
      result = await slot.engine.restore(backup, { discardUnsynced: discard });
    } catch (err) {
      // Refused before anything was written (another restore running), or
      // GitHub couldn't be reached or refused the token before the genesis
      // was sent: a restore needs the network, and writeGenesis hands such
      // answers to its caller (ADR-0008, stage 6).
      if (!(err instanceof GitHubError)) expectedRefusal(h, err);
      return;
    }
    if (result.kind === "unsynced" || result.kind === "invalid" || result.kind === "tooLarge") return;
    if (result.kind === "failed") return;
    // "Restore anyway" dropped this device's unsynced changes and every own
    // group still shown, from this epoch and every earlier one.
    if (discard) slot.discardedAt.push(from.epoch);
    slot.restored.push({ epoch: result.epoch, from: from.epoch, device: from.device });
    // "unknown": writes stay refused until a listing settles it; a cycle
    // that finds it landed rejoins (cycle()).
    if (result.kind === "restored" || (result.kind === "replaced" && !result.damagedFile)) await rejoin(h, slot);
  });
  // A third device often syncs while the two race, so it may switch to the
  // one that lands first and lose, and then often goes offline: it stays
  // on that losing epoch while a later restore is based on the winner,
  // and so skips an epoch when it comes back (sections 9.3 and 9.4).
  const others = h.slots.filter((s) => !slots.includes(s));
  if (slots.length > 1 && others.length > 0 && rng.chance(0.6)) {
    const watcher = rng.pick(others);
    const wait = rng.int(12);
    const away = rng.chance(0.6);
    runs.push(
      (async () => {
        await turns(wait);
        await cycle(h, watcher);
        if (away) watcher.offline = true;
      })(),
    );
  }
  await Promise.all(runs);
}

/** A cloned browser profile: a second device with a copy of `slot`'s
 * records, so the same device id (section 10.3). */
async function fork(h: Harness, slot: Slot, rng: Rng): Promise<void> {
  counts.forks++;
  const twin = newSlot(`${slot.name}'`, slot.login, rng);
  twin.epochs = [...slot.epochs];
  await open(h, twin, slot.store.clone());
  h.slots.push(twin);
}

/** A new device joins as #8 does: list, open the winning genesis. */
async function join(h: Harness, rng: Rng): Promise<void> {
  const slot = newSlot(`p${h.slots.length}`, rng.pick(["alex", "sam"]), rng);
  const init = await find(h, slot);
  if (!init) return;
  await open(h, slot, new MemoryStore(), init);
  counts.joins++;
  h.slots.push(slot);
}

// --- One run ------------------------------------------------------------------------

async function step(h: Harness, rng: Rng, events: { restoreAt: number[]; raceAt: number[]; forkAt: number; joinAt: number }, index: number): Promise<void> {
  counts.steps++;
  const slot = rng.pick(h.slots);
  if (events.restoreAt.includes(index) || events.raceAt.includes(index)) {
    const racing = (events.raceAt.includes(index) || rng.chance(0.4)) && h.slots.length > 1;
    const restorers = racing ? rng.shuffle(h.slots).slice(0, 2) : [slot];
    await restoreBy(h, restorers, rng);
    // A racing restore is often followed by another soon after, while
    // devices are still switching between the two.
    if (racing && rng.chance(0.5)) events.restoreAt.push(index + 1 + rng.int(3));
    if (!racing && RACE_AFTER > 0 && rng.chance(RACE_AFTER)) events.raceAt.push(index + 2 + rng.int(5));
  }
  // A backup taken while this device has changes not yet synced, more
  // often than at rest: restoring one is what leaves those changes, and
  // later ones, behind on other paths (stage 8a review, E1).
  if (slot.engine.getState().pendingCount > 0 && rng.chance(0.15)) h.backups.push(structuredClone(slot.engine.current()));
  if (index === events.forkAt) await fork(h, slot, rng);
  if (index === events.joinAt) await join(h, rng);
  // What a person does with what the list shows: often, once there is any.
  if (slot.engine.getState().leftBehindCount > 0 && rng.chance(0.2)) await leftBehindStep(h, slot, rng);
  if (slot.engine.getState().noticeCount > 0 && rng.chance(0.3)) await noticeStep(h, slot, rng);
  const roll = rng.int(100);
  if (roll < 34) await randomCall(h, slot, rng);
  else if (roll < 48) await cycle(h, slot);
  else if (roll < 52) {
    // Each view renders what its cycle joined, as after any other step.
    for (const s of h.slots) {
      await cycle(h, s);
      render(s);
    }
  }
  else if (roll < 60) fault(h, rng);
  else if (roll < 63) slot.offline = !slot.offline;
  else if (roll < 66) h.fake.staleReads(rng.chance(0.5) ? 1 + rng.int(2) : 0);
  else if (roll < 68) h.fake.cutTrees(rng.chance(0.5) ? rng.int(4) : null);
  else if (roll < 71) await reload(h, slot);
  else if (roll < 75) {
    // A reload while a write saves, or while a cycle runs: the page goes
    // after a few turns of the event loop.
    counts.midCommit++;
    const work = rng.chance(0.6) ? randomCall(h, slot, rng) : slot.engine.sync();
    const settled = work.catch((err: unknown) => expectedRefusal(h, err, true));
    await turns(rng.int(8));
    await reload(h, slot);
    h.floating.push(settled);
  } else if (roll < 77) {
    slot.store.failNext++;
    h.storeFaults++;
  } else if (roll < 82) await noticeStep(h, slot, rng);
  else if (roll < 85) await leftBehindStep(h, slot, rng);
  else if (roll < 88) slot.lag = !slot.lag;
  else if (roll < 91) h.backups.push(structuredClone(slot.engine.current()));
  else if (roll < 94) slot.skew += (rng.int(21) - 10) * DAY;
  else await cycle(h, slot);
  render(slot);
  noteEpoch(slot);
}

/** Heals every fault, then cycles every device until two rounds in a row
 * commit nothing and each device is idle with nothing pending. */
async function quiesce(h: Harness): Promise<void> {
  h.fake.staleReads(0);
  h.fake.cutTrees(null);
  h.fake.landPending();
  for (const slot of h.slots) {
    slot.offline = false;
    slot.lag = false;
    slot.store.failNext = 0;
  }
  h.storeFaults = 0;
  await Promise.allSettled(h.floating.splice(0));
  // Past any rate-limit wait (it ends on the device's own clock, B27).
  h.clock.wall += 2 * 60 * 60 * 1000;
  // Faults queued but never met are dropped by a quiet round of requests.
  let quiet = 0;
  for (let round = 0; quiet < 2; round++) {
    if (round > 40) {
      const states = h.slots.map((s) => `${s.name} ${s.engine.getState().status}/${s.engine.getState().pendingCount} dead=${s.life.dead} ${JSON.stringify(s.engine.getState())}`).join(", ");
      const requests = h.fake.requests.slice(-8).map((r) => `${r.device} ${r.method} ${r.path}`);
      throw new Error(`the devices did not quiesce: ${states}\n${h.log.slice(TRACE ? -60 : -12).join("\n")}\n${requests.join("\n")}`);
    }
    const commits = h.fake.commits.length;
    // A fault queued but not yet met (a rate limit, say) is met now; its
    // wait ends on the device's clock, which moves on.
    h.clock.wall += 10 * 60_000;
    for (const slot of h.slots) {
      await cycle(h, slot);
      render(slot);
    }
    const settled = h.slots.every((s) => s.engine.getState().status === "idle" && s.engine.getState().pendingCount === 0 && s.engine.getState().restore === null);
    quiet = h.fake.commits.length === commits && settled ? quiet + 1 : 0;
  }
}

/** Every op a device committed (its stores' own-log writes): the epoch,
 * the device id it was made under, and the slot. */
async function committedOps(h: Harness): Promise<{ slot: Slot; epoch: string; device: string; op: Op }[]> {
  const out: { slot: Slot; epoch: string; device: string; op: Op }[] = [];
  for (const slot of h.slots) {
    for (const store of slot.stores) {
      for (const m of store.mutations) {
        const meta = m.meta as SyncMeta;
        for (const [, text] of m.ownLog?.put ?? []) {
          const delta = (await unseal(text, h.key)) as { ops: [string, Op][] };
          for (const [device, op] of delta.ops) out.push({ slot, epoch: meta.epochKey, device, op });
        }
      }
    }
  }
  return out;
}

/** The ids each slot wrote under, per epoch, in order. */
function idsOf(slot: Slot): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const store of slot.stores) {
    for (const m of store.mutations) {
      const { epochKey, deviceId } = m.meta as SyncMeta;
      const list = ids.get(epochKey) ?? [];
      if (list.at(-1) !== deviceId) list.push(deviceId);
      ids.set(epochKey, list);
    }
  }
  return ids;
}

/** One left-behind item as register and deletion texts. */
function itemTexts(item: LeftBehindItem): string[] {
  if (item.kind === "unit") return [`set ${item.key} ${plainText(item.value)}`];
  if (item.kind === "delete") return [`del ${item.coll}/${item.id}`];
  const out = item.kind === "add" ? [`set ${item.coll}/${item.id}/_c`] : [];
  for (const [field, value] of Object.entries(item.fields)) out.push(`set ${item.coll}/${item.id}/${field} ${plainText(value)}`);
  return out;
}

/** What a left-behind group offers, as register and deletion texts. */
function offered(view: LeftBehindView): Set<string> {
  return new Set(view.items.flatMap(itemTexts));
}

function obligationText(ob: Obligation): string {
  if (ob.kind === "del") return `del ${ob.key}`;
  return ob.key.endsWith("/_c") ? `set ${ob.key}` : `set ${ob.key} ${plainText(ob.value)}`;
}

/** The restore cut epoch `epoch` is left behind with: the cut of the first
 * restore in the winner's line that is based on it, or nothing. */
function cutFor(history: RepoHistory, winner: string, epoch: string): Record<string, number> {
  for (let g = history.geneses.get(winner); g?.basedOn; g = history.geneses.get(g.basedOn.epoch)) {
    if (g.basedOn.epoch === epoch) return g.basedOn.seen;
  }
  return {};
}

async function check(h: Harness, where: string): Promise<void> {
  const history = await readHistory(h.fake.versions(FULL), h.key);
  expect(history.unreadable, where).toEqual([]);
  const winner = winnerOf([...history.geneses.keys()]);
  expect(winner, where).not.toBeNull();
  const W = winner!;
  const winning = history.geneses.get(W)!;
  const wOps = history.ops.get(W) ?? [];
  const finalFold = fold(winning.doc, wOps);
  const expected = documentText(documentOf(finalFold));

  // Every device on the winning epoch, showing the oracle's document.
  for (const slot of h.slots) {
    expect(slot.engine.epochKey, `${where} ${slot.name}`).toBe(W);
    expect(documentText(slot.engine.current()), `${where} ${slot.name}`).toBe(expected);
    const state = slot.engine.getState();
    expect({ status: state.status, pending: state.pendingCount, damaged: state.damagedFile, gone: state.epochGone, restore: state.restore }, `${where} ${slot.name}`).toEqual({ status: "idle", pending: 0, damaged: null, gone: null, restore: null });
  }

  // Ids: which slot wrote under which id, and which ids a fork shared.
  // An id a slot left by rehoming is abandoned by that slot only: its
  // twin may still write under it.
  const owners = new Map<string, Slot[]>();
  const abandoned = new Set<string>();
  const slotIds = new Map<Slot, Map<string, string[]>>();
  for (const slot of h.slots) {
    const ids = idsOf(slot);
    slotIds.set(slot, ids);
    for (const [epoch, list] of ids) {
      list.forEach((id, i) => {
        const key = `${epoch}/${id}`;
        owners.set(key, [...(owners.get(key) ?? []), slot]);
        if (i < list.length - 1) abandoned.add(`${slot.name}|${key}`);
      });
    }
  }
  const abandonedBy = (slot: Slot, epoch: string, id: string) => abandoned.has(`${slot.name}|${epoch}/${id}`);
  const shared = (epoch: string, id: string) => (owners.get(`${epoch}/${id}`)?.length ?? 0) > 1 || h.slots.some((slot) => abandonedBy(slot, epoch, id));
  counts.rehomes += abandoned.size;

  // No (device, L) published with two contents, but by a cloned id.
  for (const [epoch, ops] of history.ops) {
    const byId = new Map<string, string>();
    for (const { device, op } of ops) {
      const id = `${device}/${op.L}`;
      if (byId.has(id) && byId.get(id) !== plainText(op)) expect(shared(epoch, device), `${where}: ${epoch}/${id} published twice`).toBe(true);
      byId.set(id, plainText(op));
    }
  }

  // Every op committed in the winning epoch reached the repo: exactly, or,
  // under a cloned or abandoned id, with each of its writes held by an op
  // at its L or later (its rehome re-issued it).
  const committed = await committedOps(h);
  const published = new Set(wOps.map(({ device, op }) => `${device}/${op.L}/${plainText(op)}`));
  for (const c of committed.filter((x) => x.epoch === W)) {
    if (published.has(`${c.device}/${c.op.L}/${plainText(c.op)}`)) continue;
    expect(shared(W, c.device), `${where}: ${c.slot.name}'s op ${c.device}/${c.op.L} never reached the repo`).toBe(true);
    for (const [key] of c.op.set) {
      if (key.endsWith("/_s")) continue;
      const rk = key.split("/").slice(0, 2).join("/");
      const k = key.endsWith("/remainingAsOf") || key.endsWith("/asOfDate") ? `${rk}/#balance` : key;
      const cell = finalFold.cells.get(k);
      expect(finalFold.dels.has(rk) || (cell !== undefined && cell.L >= c.op.L), `${where}: ${c.device}/${c.op.L} ${key} was lost`).toBe(true);
    }
    for (const rk of c.op.del) expect(finalFold.dels.has(rk), `${where}: ${c.device}/${c.op.L} deleted ${rk}, lost`).toBe(true);
  }

  // Nothing invented in a snapshot: every write it holds, an op or a
  // genesis made.
  for (const [epoch, snaps] of history.snaps) {
    const genesis = history.geneses.get(epoch);
    if (!genesis) continue;
    const writes = writesOf(genesis.doc, history.ops.get(epoch) ?? []);
    for (const { device, state } of snaps) {
      counts.snapshots++;
      for (const w of snapshotWrites(state)) expect(writes.has(w), `${where}: ${epoch} ${device}'s snapshot holds ${w}`).toBe(true);
    }
  }

  // The winner's line: it, the epoch its genesis is based on, and so on.
  const line = new Set<string>([W]);
  for (let g = history.geneses.get(W); g?.basedOn && !line.has(g.basedOn.epoch); g = history.geneses.get(g.basedOn.epoch)) line.add(g.basedOn.epoch);

  // Every change a restore left out is accounted for (AC6, AC13, D18).
  for (const [epoch, genesis] of history.geneses) {
    if (epoch === W) continue;
    const mine = committed.filter((c) => c.epoch === epoch && !abandonedBy(c.slot, epoch, c.device));
    const ops: OracleOp[] = [...(history.ops.get(epoch) ?? [])];
    const inRepo = new Set(ops.map(({ device, op }) => `${device}/${op.L}/${plainText(op)}`));
    for (const c of mine) if (!inRepo.has(`${c.device}/${c.op.L}/${plainText(c.op)}`)) ops.push({ device: c.device, op: c.op });
    const writes = writesOf(genesis.doc, [...ops, ...committed.filter((c) => c.epoch === epoch).map((c) => ({ device: c.device, op: c.op }))]);
    const cut = cutFor(history, W, epoch);
    /** The markers `ob`'s group may carry there: its device's, or an id
     * its device's slot rehomed to in that epoch. */
    const markersOf = (ob: Obligation) => new Set([ob.device, ...(owners.get(`${epoch}/${ob.device}`) ?? []).flatMap((o) => slotIds.get(o)?.get(epoch) ?? [])].map((d) => `${epoch}/${d}`));
    // Re-applied into the winner's line by any device: an item a re-apply
    // result listed as applied (and found in effect or told then), or the
    // same write in the winning epoch by an op carrying the group's marker
    // (not any equal write: another device may have made it on its own).
    const reapplied = (ob: Obligation, text: string): boolean => {
      const markers = markersOf(ob);
      if (h.slots.some((s) => [...markers].some((m) => (s.settled.get(`${m}|${text}`) ?? []).some((done) => done.how === "applied" && line.has(done.epoch))))) return true;
      return wOps.some(({ op }) => (op.ra ?? []).some((m) => markers.has(m)) && (ob.kind === "del" ? op.del.includes(ob.key) : op.set.some(([key, value]) => key === ob.key && (key.endsWith("/_c") || plainText(value) === plainText(ob.value)))));
    };
    for (const ob of obligations(epoch, genesis.doc, ops, cut)) {
      counts.obligations++;
      // The near-top phantom has no device to offer its change on (D18 owes
      // it to its own device): like any retired device's, it may show
      // only in other devices' collapsed lists, so it is not owed here.
      if (ob.device === PHANTOM) continue;
      const slots = owners.get(`${epoch}/${ob.device}`) ?? [];
      expect(slots.length, `${where}: ${epoch}/${ob.device} belongs to no device`).toBeGreaterThan(0);
      const text = obligationText(ob);
      // Re-applied by any device into the winner's line (AC6), whatever
      // later writes did to it.
      if (reapplied(ob, text)) {
        counts.reappliedOb++;
        continue;
      }
      const settled = slots.some((slot) => {
        if (holdsIn(finalFold, ob)) return true;
        // Held by a genesis in the winner's line it switched to (a losing
        // restore's genesis holds nothing for the winner).
        const after = slot.epochs.slice(slot.epochs.indexOf(epoch) + 1);
        if (after.some((e) => line.has(e) && history.geneses.has(e) && holds(history.geneses.get(e)!.doc, ob))) return true;
        // Skipped (it said why) or discarded on its own device, item by
        // item, in the winner's line (in a losing epoch neither is an
        // answer: the group is offered again, D18).
        if ([...markersOf(ob)].some((m) => (slot.settled.get(`${m}|${text}`) ?? []).some((done) => done.how !== "applied" && line.has(done.epoch)))) return true;
        if (slot.discardedAt.some((at) => slot.epochs.indexOf(epoch) <= slot.epochs.indexOf(at))) return true;
        const own = slot.restored.find((r) => r.from === epoch && r.device === ob.device);
        if (own && ob.L <= (history.geneses.get(own.epoch)?.basedOn?.seen[ob.device] ?? 0)) return true;
        // A rehome re-issued the change under the slot's next id there.
        const ids = slotIds.get(slot)!.get(epoch) ?? [];
        const groups = slot.engine.leftBehind().filter((g) => g.epoch === epoch && ids.includes(g.device));
        if (groups.some((g) => offered(g).has(text))) {
          counts.offered++;
          return true;
        }
        return false;
      });
      const story = slots.map((s) => `${s.name}: epochs ${s.epochs.join(">")}, restored ${JSON.stringify(s.restored)}, resolved [${[...s.resolved].join(",")}], discardedAt [${s.discardedAt.join(",")}], groups ${JSON.stringify(s.engine.leftBehind().map((g) => ({ id: g.id, own: g.own, items: [...offered(g)] })))}, ids ${JSON.stringify([...(slotIds.get(s) ?? new Map())])}`).join("; ") + ` ALL: ${h.slots.map((s) => `${s.name} epochs ${s.epochs.join(">")} restored ${JSON.stringify(s.restored)} resolved [${[...s.resolved].join(",")}] discardedAt [${s.discardedAt.join(",")}] ids ${JSON.stringify([...(slotIds.get(s) ?? new Map())])}`).join(" / ")}`;
      expect(settled, `${where}: ${ob.device}'s ${text} in ${epoch} (L ${ob.L}, cut ${cut[ob.device] ?? 0}) was left behind and is offered nowhere. ${story}. Geneses: ${[...history.geneses.values()].map((g) => `${g.epoch} based on ${JSON.stringify(g.basedOn)}`).join("; ")}`).toBe(true);
    }
    // Nothing invented in what is offered, and nothing offered that the
    // winner's line holds: each item is a write that group's device made
    // in that epoch above the cut the winner's line left it behind with.
    const above = (device: string, L: string) => Number(L) > (cut[device] ?? 0);
    const parsed = [...writes].map((w) => w.split(" "));
    for (const slot of h.slots) {
      for (const g of slot.engine.leftBehind().filter((x) => x.epoch === epoch)) {
        for (const item of offered(g)) {
          const [kind, key, ...rest] = item.split(" ");
          const value = rest.join(" ");
          const made =
            kind === "del"
              ? parsed.some(([k, rk, L, by]) => k === "del" && rk === key && by === g.device && above(by, L))
              : parsed.some(([k, L, d, ...v]) => k === key && d === g.device && above(d, L) && (key.endsWith("/_c") || v.join(" ") === value));
          expect(made, `${where}: ${slot.name} offers ${item} from ${g.device} in ${epoch} (cut ${cut[g.device] ?? 0}), which no op made above the cut`).toBe(true);
        }
      }
    }
  }

  // AC10 and AC15.
  expect(h.fake.violations, where).toEqual([]);
  for (const { path, text } of h.fake.versions(FULL)) for (const remark of REMARKS) expect(text.includes(remark), `${where}: ${path} holds ${remark}`).toBe(false);
  for (const slot of h.slots) for (const store of slot.stores) for (const remark of REMARKS) expect(JSON.stringify(store.meta() ?? {}).includes(remark)).toBe(false);
}

/** An idle round: one request a device, no PUT (AC9). */
async function idleRound(h: Harness, where: string): Promise<void> {
  for (const slot of h.slots) {
    const before = h.fake.requests.length;
    await cycle(h, slot);
    const sent = h.fake.requests.slice(before);
    expect(sent.filter((r) => r.method === "PUT"), `${where} ${slot.name}`).toEqual([]);
    expect(sent.length, `${where} ${slot.name}`).toBeLessThanOrEqual(1);
  }
}

async function run(seed: number): Promise<void> {
  const rng = new Rng(seed);
  seedCrypto(seed);
  const where = `seed ${seed}`;
  // GitHub's rate limits run on the devices' monotonic time, which a
  // schedule moves on by hours in seconds of real time.
  const clock = { wall: Date.UTC(2026, 4, 10, 9), mono: 1_000_000 };
  const fake = createFakeGitHub({
    now: () => clock.mono,
    repos: [{ owner: OWNER, name: REPO, private: true }],
    tokens: {
      github_pat_alex: { login: "alex", repos: [FULL], permission: "write" },
      github_pat_sam: { login: "sam", repos: [FULL], permission: "write" },
    },
  });
  const key = await seededKey(rng);
  const doc = await startingDocument(rng);
  const epoch = "e000001-0000000a";
  await fake.seedFile(FULL, `ledger/${epoch}.genesis.enc`, await seal({ fv: FORMAT_VERSION, kind: "genesis", epoch, reason: "create", by: "alex", at: Date.UTC(2026, 4, 1), basedOn: null, doc }, key));
  // Sometimes the run starts near the top of the Lamport range: another
  // device's op sits a few dozen Ls below 2^50, so writes run out of L and
  // start next epochs (ADR-0008) amid everything else.
  if (LAMPORT_TOP > 0 && rng.chance(LAMPORT_TOP)) {
    counts.nearTop++;
    const top = MAX_L - 20 - rng.int(40);
    const op: Op = { L: top, at: 1, by: "sam", vv: {}, set: [["lk/2026-12", true]], del: [] };
    const log = { fv: FORMAT_VERSION, kind: "log", epoch, device: PHANTOM, snapThrough: 0, chain: "0".repeat(16), ops: [op] };
    await fake.seedFile(FULL, `ledger/${epoch}.${PHANTOM}.log.enc`, await seal(log, key));
  }
  const h: Harness = { rng, fake, key, clock, slots: [], backups: [structuredClone(doc)], floating: [], storeFaults: 0, log: [] };
  const count = 2 + rng.int(3);
  for (let i = 0; i < count; i++) {
    const slot = newSlot(`p${i}`, i % 2 ? "sam" : "alex", rng);
    await open(h, slot, new MemoryStore(), { epoch, state: genesisState(doc) });
    h.slots.push(slot);
  }
  const restoreAt: number[] = [];
  if (rng.chance(0.5)) restoreAt.push(5 + rng.int(Math.max(1, STEPS - 10)));
  if (restoreAt.length > 0 && rng.chance(0.3)) restoreAt.push(5 + rng.int(Math.max(1, STEPS - 10)));
  const events = { restoreAt, raceAt: [] as number[], forkAt: rng.chance(0.25) ? rng.int(STEPS) : -1, joinAt: rng.chance(0.2) ? rng.int(STEPS) : -1 };

  for (let i = 0; i < STEPS; i++) await step(h, rng, events, i);
  await quiesce(h);
  for (const slot of h.slots) if (slot.epochs.length > 1) counts.switches += slot.epochs.length - 1;
  for (const line of h.log) {
    const held = /\((\d+) parts a losing genesis held offered again, (\d+) held back, (\d+) superseded\)/.exec(line);
    if (held) {
      counts.offeredAgain += Number(held[1]);
      if (Number(held[2]) > 0) counts.heldBack++;
      counts.superseded += Number(held[3]);
    }
  }
  await check(h, where);
  await idleRound(h, where);

  // No device is blocked: a new write on each one reaches every device.
  // A 503 is a "try again" (another device just started a next epoch at
  // the top of the Lamport range): the person tries again after a sync,
  // and by the second try it must go through.
  for (const slot of h.slots) {
    for (let attempt = 1; ; attempt++) {
      const refused = await slot.backend.addEntry({ year: 2026, month: 7, amount: 1, remarks: `Probe ${slot.name}`, category: "food", isCard: false }).then(
        () => null,
        (err: unknown) => err,
      );
      // A write refused at the origin (expenses off, July locked) is no block.
      if (refused === null || (refused instanceof ApiError && [403, 404].includes(refused.status))) break;
      if (refused instanceof ApiError && refused.status === 503 && attempt < 3) {
        await cycle(h, slot);
        continue;
      }
      throw new Error(`the probe write on ${slot.name} failed: ${String(refused)}\n${h.log.slice(-20).join("\n")}`, { cause: refused });
    }
  }
  await quiesce(h);
  await check(h, `${where} (after a write on every device)`);
  counts.told += h.slots.flatMap((s) => s.stores).flatMap((s) => s.mutations).reduce((n, m) => n + (m.notices?.put?.length ?? 0), 0);
  for (const slot of h.slots) slot.engine.stop();
}

describe("property harness (section 16.4): every device equals an independent oracle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it(`converges on the oracle, loses nothing and invents nothing over ${SEEDS} seeds x ${STEPS} steps`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const seeds = ONLY !== undefined ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, i) => FIRST + i);
    const failures: string[] = [];
    for (const seed of seeds) {
      try {
        await run(seed);
      } catch (err) {
        const message = `seed ${seed} failed (replay with LEDGER_HARNESS_SEED=${seed} LEDGER_HARNESS_STEPS=${STEPS}): ${err instanceof Error ? err.message : String(err)}`;
        if (!KEEP_GOING) throw new Error(message, { cause: err });
        failures.push(message);
      } finally {
        for (const engine of started.splice(0)) engine.stop();
        vi.restoreAllMocks();
      }
    }
    console.log(`property harness: ${seeds.length} seeds (${seeds[0]}-${seeds.at(-1)}) x ${STEPS} steps`, JSON.stringify(counts));
    expect(failures).toEqual([]);
    if (ONLY === undefined && SEEDS >= 8) {
      for (const name of ["writes", "cycles", "faults", "reloads", "midCommit", "notices", "snapshots"] as const) expect(counts[name], name).toBeGreaterThan(0);
    }
  }, Math.max(600_000, SEEDS * STEPS * 30));
});
