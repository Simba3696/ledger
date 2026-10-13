import "fake-indexeddb/auto";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentBackend } from "../../backend/document/DocumentBackend";
import { MemoryStore } from "../../backend/sync/cycleTestkit";
import { damagedFileMessage } from "../../backend/sync/ledgerRepo";
import type { LeftBehindView } from "../../backend/sync/SyncEngine";
import { EPOCH_GONE, EPOCH_GONE_EMPTY, RESTORED, RESTORE_UNKNOWN, SyncEngine, type EngineState } from "../../backend/sync/SyncEngine";
import { SyncedHost } from "../../backend/sync/SyncedHost";
import { testKey } from "../../backend/sync/localTestkit";
import type { ActionPreview, NoticeView } from "../../backend/sync/noticeActions";
import type { StoredNotice } from "../../backend/sync/notices";
import { genesisState, type Op } from "../../backend/sync/state";
import { Replica, deviceId, emptyDocument } from "../../backend/sync/testkit";
import { LeftBehindList } from "./LeftBehindList";
import { NoticeList } from "./NoticeList";
import { SyncHost } from "./SyncHost";
import { SyncMessages, VOLATILE } from "./SyncMessages";
import { SyncPanel } from "./SyncPanel";
import { SyncStatus } from "./SyncStatus";
import { actionLabel, leftBehindItemText, monthLabel, noticeText, reapplyText, refusalText, reviewText, statusText, valueText } from "./labels";
import { useSyncState } from "./syncContext";

// GitHub mode's sync UI (#7 stage 7): the status line with "N to review",
// the notices with their actions, the changes a restore left behind (D18),
// and the messages for a damaged file, a gone epoch and a restore. The
// client tests run without a DOM, so the components are server-rendered,
// and the hook-free ones are also called directly to reach their click
// handlers. Fictional data only.

const A = deviceId(0xa);
const B = deviceId(0xb);
const ID = "00000000-0000-4000-8000-000000000001";
const EMI = "00000000-0000-4000-8000-000000000002";

const running: SyncEngine[] = [];
afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.restoreAllMocks();
});

/** Every element `node` renders, function components called through (only
 * for hook-free ones), in document order. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const { type, props } = node as ReactElement<{ children?: ReactNode }>;
  if (typeof type === "function") return elements((type as (p: unknown) => ReactNode)(props));
  return [node, ...elements(props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement(node)) return "";
  const { type, props } = node as ReactElement<{ children?: ReactNode }>;
  if (typeof type === "function") return text((type as (p: unknown) => ReactNode)(props));
  return text(props.children);
}

function button(node: ReactNode, label: string | RegExp): ReactElement<{ onClick: () => void; disabled?: boolean; "aria-describedby"?: string; "aria-expanded"?: boolean }> {
  const found = elements(node).filter((el) => el.type === "button" && (typeof label === "string" ? text(el) === label : label.test(text(el))));
  if (found.length !== 1) throw new Error(`expected one button ${String(label)}, found ${found.length}`);
  return found[0] as ReactElement<{ onClick: () => void }>;
}

const STATE: EngineState = {
  status: "idle",
  hasDocument: true,
  needsInit: false,
  unreadable: null,
  revision: 0,
  pendingCount: 0,
  deviceSaveFailed: false,
  volatile: false,
  noticeCount: 0,
  noticeRevision: 0,
  leftBehindCount: 0,
  leftBehindOwnCount: 0,
  damagedFile: null,
  epochGone: null,
  restore: null,
};

type Body = StoredNotice extends infer N ? (N extends StoredNotice ? Omit<N, "seq" | "at"> : never) : never;
const stored = (notice: Body): StoredNotice => ({ ...notice, seq: 1, at: 0 }) as StoredNotice;
const ok = (kind: ActionPreview["kind"], writes: ActionPreview["writes"], extra: Partial<ActionPreview> = {}): ActionPreview => ({ kind, writes, refused: null, ...extra });

const amountClash: NoticeView = {
  key: `5.${B}/4.${A}`,
  notice: stored({ kind: "overwrite", winner: { L: 5, device: B, by: "sam" }, loser: { L: 4, device: A }, target: { kind: "record", coll: "e", id: ID, month: "2026-05", name: "Groceries" }, registers: [{ key: `e/${ID}/amount`, theirs: "12.00", mine: "10.00" }] }),
  names: { [`e/${ID}`]: "Groceries" },
  actions: [ok("useMine", [{ key: `e/${ID}/amount`, value: "10.00" }])],
};

const deleted: NoticeView = {
  key: `6.${B}/4.${A}`,
  notice: stored({ kind: "deleted", winner: { L: 6, device: B, by: "sam" }, loser: { L: 4, device: A }, target: { kind: "record", coll: "e", id: ID, month: "2026-05", name: "Groceries" } }),
  names: { [`e/${ID}`]: "Groceries" },
  actions: [ok("addBack", [{ key: `e/${ID}/amount`, value: "45.00" }, { key: `e/${ID}/remarks`, value: "Groceries" }])],
};

const payment: NoticeView = {
  key: `7.${B}/4.${A}`,
  notice: stored({
    kind: "overwrite",
    winner: { L: 7, device: B, by: "sam" },
    loser: { L: 4, device: A },
    target: { kind: "record", coll: "emi", id: EMI, month: null, name: "Car Loan" },
    registers: [
      { key: `emi/${EMI}/remainingAsOf`, theirs: "8000.00", mine: "8000.00" },
      { key: `emi/${EMI}/asOfDate`, theirs: "2026-06-05", mine: "2026-06-05" },
    ],
  }),
  names: { [`emi/${EMI}`]: "Car Loan" },
  actions: [
    ok("recordAgain", [{ key: `emi/${EMI}/remainingAsOf`, value: "7000.00" }, { key: `emi/${EMI}/asOfDate`, value: "2026-07-05" }], { paid: "1000.00" }),
    { kind: "useMine", writes: [], refused: { reason: "inEffect" } },
  ],
};

const unlocked: NoticeView = {
  key: `8.${B}/4.${A}`,
  notice: stored({ kind: "overwrite", winner: { L: 8, device: B, by: null }, loser: { L: 4, device: A }, target: { kind: "unit", key: "lk/2026-05" }, registers: [{ key: "lk/2026-05", theirs: false, mine: true }] }),
  names: {},
  actions: [{ kind: "useMine", writes: [{ key: "lk/2026-05", value: true }], refused: { reason: "moduleOff" } }],
};

describe("labels", () => {
  it("say whose write won and what was replaced, with exact values", () => {
    expect(noticeText(amountClash)).toBe("sam changed Groceries · amount to 12.00; your 10.00 was replaced.");
    expect(actionLabel(amountClash, amountClash.actions[0])).toBe("Use 10.00");
    expect(noticeText(deleted)).toBe("sam deleted Groceries (May 2026) while you edited it.");
    expect(actionLabel(deleted, deleted.actions[0])).toBe("Add it back as a new entry: Groceries, 45.00");
    expect(noticeText(payment)).toBe("sam also recorded a payment or balance on Car Loan (8000.00 remaining as of 2026-06-05); yours (8000.00 remaining as of 2026-06-05) was replaced.");
    expect(actionLabel(payment, payment.actions[0])).toBe("Record again: pay 1000.00, leaving 7000.00 remaining as of 2026-07-05");
    expect(actionLabel(payment, payment.actions[1])).toBe("Use mine");
    expect(refusalText(payment.actions[1])).toBe("The ledger already has that.");
    expect(noticeText(unlocked)).toBe("Another device unlocked May 2026; your lock was replaced.");
    expect(refusalText(unlocked.actions[0])).toBe("That section is turned off.");
    const relock = { ...unlocked, actions: [ok("useMine", [{ key: "lk/2026-05", value: true }])] };
    expect(actionLabel(relock, relock.actions[0])).toBe("Lock it again");
  });

  it("whole units, settings, fence and rehome notices", () => {
    const income: NoticeView = {
      key: "k",
      notice: stored({ kind: "overwrite", winner: { L: 3, device: B, by: "sam" }, loser: { L: 2, device: A }, target: { kind: "unit", key: "fm/2026-05" }, registers: [{ key: "fm/2026-05", theirs: { salary: "65000.00", otherIncome: null, savings: [] }, mine: { salary: "60000.00", otherIncome: "5.00", savings: [{ name: "Fund", amount: "10.00" }] } }] }),
      names: {},
      actions: [ok("useMine", [{ key: "fm/2026-05", value: { salary: "60000.00", otherIncome: "5.00", savings: [{ name: "Fund", amount: "10.00" }] } }])],
    };
    expect(noticeText(income)).toBe("sam changed the finances for May 2026 to salary 65000.00, other income -; your salary 60000.00, other income 5.00, savings Fund 10.00 was replaced.");
    expect(actionLabel(income, income.actions[0])).toBe("Use mine: the finances for May 2026 salary 60000.00, other income 5.00, savings Fund 10.00");
    expect(valueText("cb/2026-05", [{ name: "Card A", due: "100.00", paid: "0.00", settled: true }])).toBe("Card A: due 100.00, paid 0.00, settled");
    expect(valueText("st/modules", ["expenses", "emi"])).toBe("expenses, emi");
    const kept: NoticeView = { key: "k", notice: stored({ kind: "kept", theirs: [3, B], mine: [4, A], registers: [{ key: `e/${ID}/amount`, theirs: "12.00", mine: "40.00" }] }), names: { [`e/${ID}`]: "Groceries" }, actions: [] };
    expect(noticeText(kept)).toBe("Another device changed Groceries · amount to 12.00 just before you saved; its value was kept.");
    const replaced: NoticeView = { ...kept, notice: stored({ kind: "replaced", theirs: [3, B], mine: [4, A], registers: [{ key: `e/${ID}/amount`, theirs: "12.00", mine: "15.00" }] }) };
    expect(noticeText(replaced)).toBe("Your 15.00 replaced 12.00 from another device for Groceries · amount, which you hadn't seen yet.");
    expect(noticeText({ key: "r", notice: stored({ kind: "rehome", from: A, to: B, message: "Moved." }), names: {}, actions: [] })).toBe("Moved.");
    expect(monthLabel("2026-12")).toBe("December 2026");
  });

  it("the status line covers every status, and N to review counts notices and groups", () => {
    expect(statusText(STATE)).toBe("Saved");
    expect(statusText({ ...STATE, pendingCount: 2 })).toBe("Saving...");
    expect(statusText({ ...STATE, status: "pending", pendingCount: 1 })).toBe("Offline, 1 change not saved yet");
    expect(statusText({ ...STATE, status: "pending", pendingCount: 3 })).toBe("Offline, 3 changes not saved yet");
    expect(statusText({ ...STATE, status: "needsAttention" })).toBe("Changes from one device can't be read. Everything else keeps syncing.");
    expect(statusText({ ...STATE, deviceSaveFailed: true, status: "pending" })).toBe("This device couldn't save. Free up storage and try again.");
    for (const status of ["saving", "needsToken", "needsPassphrase", "missing", "unreadable", "needsUpdate", "locked"] as const) expect(statusText({ ...STATE, status })).not.toBe("");
    expect(reviewText(STATE)).toBeNull();
    expect(reviewText({ noticeCount: 2, leftBehindCount: 1 })).toBe("3 to review");
  });

  it("left-behind changes and a re-apply's result", () => {
    const add = { kind: "add" as const, coll: "e" as const, id: ID, record: { id: ID, remarks: "Taxi", amount: "20.00" }, fields: { amount: "20.00" }, month: "2026-05" };
    expect(leftBehindItemText(add)).toBe("Added Taxi (20.00) in May 2026");
    expect(leftBehindItemText({ kind: "edit", coll: "e", id: ID, record: { id: ID, remarks: "Bus" }, fields: { amount: "3.00" } })).toBe("Changed Bus: amount 3.00");
    expect(leftBehindItemText({ kind: "delete", coll: "debt", id: ID, record: { id: ID, name: "Sam" } })).toBe("Deleted Sam");
    expect(leftBehindItemText({ kind: "unit", key: "lk/2026-05", value: true })).toBe("the lock on May 2026: locked");
    expect(reapplyText({ applied: [add], skipped: [] })).toBe("Re-applied 1 change.");
    expect(reapplyText({ applied: [], skipped: [{ item: add, reason: "monthLocked" }] })).toBe("Re-applied 0 changes. Skipped: Added Taxi (20.00) in May 2026 (its month is locked).");
  });
});

describe("SyncStatus", () => {
  it("shows the status politely, Try again while pending, and N to review as a toggle for the list", () => {
    const toggles: string[] = [];
    const node = SyncStatus({ state: { ...STATE, status: "pending", pendingCount: 2, noticeCount: 1, leftBehindCount: 1 }, reviewOpen: false, reviewId: "rv", onRetry: () => toggles.push("retry"), onToggleReview: () => toggles.push("toggle") });
    const html = renderToString(node);
    expect(html).toContain('role="status"');
    expect(html).toContain("Offline, 2 changes not saved yet");
    const review = button(node, "2 to review");
    expect(review.props["aria-expanded"]).toBe(false);
    review.props.onClick();
    button(node, "Try again").props.onClick();
    expect(toggles).toEqual(["toggle", "retry"]);
    expect(renderToString(SyncStatus({ state: STATE, reviewOpen: false, reviewId: "rv", onRetry: () => {}, onToggleReview: () => {} }))).not.toContain("to review");
  });
});

describe("NoticeList", () => {
  it("offers each action with the exact value it writes, and Dismiss; a refused one is disabled with its reason", () => {
    const calls: string[] = [];
    const node = NoticeList({ notices: [amountClash, deleted, payment], work: { busy: null, errors: {} }, onAction: (key, kind) => calls.push(`${kind} ${key}`), onDismiss: (key) => calls.push(`dismiss ${key}`) });
    button(node, "Use 10.00").props.onClick();
    button(node, "Add it back as a new entry: Groceries, 45.00").props.onClick();
    button(node, /^Record again: pay 1000.00/).props.onClick();
    const useMine = button(node, "Use mine");
    expect(useMine.props.disabled).toBe(true);
    expect(useMine.props["aria-describedby"]).toBe(`${payment.key}-useMine-why`);
    (elements(node).filter((el) => el.type === "button" && text(el) === "Dismiss")[0].props as { onClick: () => void }).onClick();
    expect(calls).toEqual([`useMine ${amountClash.key}`, `addBack ${deleted.key}`, `recordAgain ${payment.key}`, `dismiss ${amountClash.key}`]);
    const html = renderToString(node);
    expect(html).toContain("The ledger already has that.");
    expect(html).not.toContain('role="dialog"');
  });

  it("disables a notice's buttons while its action runs, and shows the error it ended with", () => {
    const node = NoticeList({ notices: [amountClash], work: { busy: amountClash.key, errors: { [amountClash.key]: "That month is locked. Unlock it first." } }, onAction: () => {}, onDismiss: () => {} });
    expect(button(node, "Use 10.00").props.disabled).toBe(true);
    expect(renderToString(node)).toContain('role="alert"');
    expect(NoticeList({ notices: [], work: { busy: null, errors: {} }, onAction: () => {}, onDismiss: () => {} })).toBeNull();
  });
});

describe("LeftBehindList (D18)", () => {
  const group = (own: boolean, device: string, extra: Partial<LeftBehindView> = {}): LeftBehindView => ({
    id: `e000001-0000000a/${device}`,
    epoch: "e000001-0000000a",
    device,
    own,
    who: own ? "alex" : "sam",
    into: { epoch: "e000002-0000000b", by: "kai", at: Date.UTC(2026, 4, 12) },
    resolvedElsewhere: false,
    items: [{ kind: "add", coll: "e", id: ID, record: { id: ID, remarks: own ? "Taxi" : "Bus", amount: "20.00" }, fields: {}, month: "2026-05" }],
    ...extra,
  });

  it("shows this device's own changes first and prominently, and other devices' collapsed", () => {
    const calls: string[] = [];
    const own = group(true, A, { resolvedElsewhere: true });
    const theirs = group(false, B);
    const node = LeftBehindList({ groups: [own, theirs], work: { busy: null, errors: {} }, onReapply: (id) => calls.push(`re ${id}`), onDiscard: (id) => calls.push(`dis ${id}`) });
    const html = renderToString(node);
    expect(html.indexOf("Taxi")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Bus"));
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain("Changes from other devices not in the restore (1)");
    expect(html).toContain("1 change made on this device wasn&#x27;t in it.");
    expect(html).toContain("1 change from sam wasn&#x27;t in kai&#x27;s restore");
    expect(html).toContain("Another device already re-applied or discarded these");
    const buttons = elements(node).filter((el) => el.type === "button");
    expect(buttons.map(text)).toEqual(["Re-apply", "Discard", "Re-apply", "Discard"]);
    (buttons[0].props as { onClick: () => void }).onClick();
    (buttons[3].props as { onClick: () => void }).onClick();
    expect(calls).toEqual([`re ${own.id}`, `dis ${theirs.id}`]);
    expect(LeftBehindList({ groups: [], work: { busy: null, errors: {} }, onReapply: () => {}, onDiscard: () => {} })).toBeNull();
  });
});

describe("SyncMessages", () => {
  it("uses the engine's own words for a damaged file, a gone epoch and a restore", () => {
    const damagedFile = { path: "ledger/e000002-0000000b.genesis.enc", epoch: "e000002-0000000b", reason: "malformed" as const };
    const html = renderToString(SyncMessages({ state: { damagedFile, epochGone: { epoch: "e000001-0000000a", winner: null }, restore: { state: "landed", epoch: "e000002-0000000b" }, volatile: false } }));
    expect(html).toContain(damagedFileMessage(damagedFile).replaceAll("'", "&#x27;").slice(0, 60));
    expect(html).toContain(EPOCH_GONE_EMPTY.replaceAll("'", "&#x27;"));
    expect(html).toContain(RESTORED);
    expect(html.match(/role="alert"/g)).toHaveLength(3);
    expect(renderToString(SyncMessages({ state: { damagedFile: null, epochGone: { epoch: "e000001-0000000a", winner: "e000002-0000000b" }, restore: { state: "pending", epoch: "e" }, volatile: false } }))).toContain(EPOCH_GONE.replaceAll("'", "&#x27;").slice(0, 40));
    expect(renderToString(SyncMessages({ state: { damagedFile: null, epochGone: null, restore: { state: "pending", epoch: "e" }, volatile: false } }))).toContain(RESTORE_UNKNOWN.replaceAll("'", "&#x27;"));
    expect(SyncMessages({ state: { damagedFile: null, epochGone: null, restore: null, volatile: false } })).toBeNull();
    // A browser that keeps nothing on the device: a banner, not an alert.
    const banner = renderToString(SyncMessages({ state: { damagedFile: null, epochGone: null, restore: null, volatile: true } }));
    expect(banner).toContain(VOLATILE.replaceAll("'", "&#x27;"));
    expect(banner).toContain('role="status"');
    expect(banner).not.toContain('role="alert"');
  });
});

describe("SyncPanel inside SyncHost", () => {
  it("reads the engine's notices through the context and lists them with their actions", async () => {
    const engine = new SyncEngine({ key: await testKey(), actor: "alex", store: new MemoryStore(), locks: null, log: () => {} });
    running.push(engine);
    await engine.start();
    await engine.initialize("e000001-0000000a", genesisState(emptyDocument()));
    const backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
    await backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
    const sam = new Replica(B, emptyDocument(), { actor: "sam" });
    for (const op of engine.pushableOps()) sam.receive(engine.deviceId!, op);
    const [row] = await backend.getMonth(2026, 5);
    await backend.updateEntry(2026, 5, row.row, { amount: 10, remarks: "Groceries", category: "food", isCard: false });
    await sam.backend.setMonthLock(2026, 7, true);
    const [samRow] = await sam.backend.getMonth(2026, 5);
    await sam.backend.updateEntry(2026, 5, samRow.row, { amount: 12, remarks: "Groceries", category: "food", isCard: false });
    await engine.join({ ops: sam.ops.slice(-2).map((op): [string, Op] => [B, op]) });
    expect(engine.getState().noticeCount).toBe(1);

    const html = renderToString(createElement(SyncHost, { engine }, createElement(SyncPanel, { initiallyOpen: true })));
    expect(html).toContain("1 to review");
    expect(html).toContain("sam changed Groceries · amount to 12.00; your 10.00 was replaced.");
    expect(html).toContain("Use 10.00");
    expect(html).toContain('aria-expanded="true"');
    const closed = renderToString(createElement(SyncHost, { engine }, createElement(SyncPanel)));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Use 10.00");
  });

  it("useSyncState needs a SyncHost above it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Probe = () => {
      useSyncState();
      return null;
    };
    expect(() => renderToString(createElement(Probe))).toThrow("useSyncState() needs a <SyncHost> above it");
  });
});
