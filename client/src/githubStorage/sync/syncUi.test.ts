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
import { SyncHost, SyncLayers } from "./SyncHost";
import { SyncMessages, VOLATILE } from "./SyncMessages";
import { SyncPanel } from "./SyncPanel";
import { SyncStatus } from "./SyncStatus";
import { actionLabel, leftBehindHeading, leftBehindItemText, monthLabel, noticeText, reapplyText, refusalText, reviewText, statusText, valueText } from "./labels";
import { useSyncState, type SyncStateValue } from "./syncContext";
import { nextFocus } from "./reviewFocus";
import syncCss from "./sync.css?raw";

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

/** The (type, key, place) of each element from `node` down to `target`,
 * function components not called through: what React matches an element
 * by when it renders again. Null when `target` isn't under `node`. */
function pathTo(node: ReactNode, target: ReactElement, place = 0): unknown[] | null {
  if (!isValidElement(node)) return null;
  const here = [node.type, node.key, place];
  if (node === target) return [here];
  const children = (node.props as { children?: ReactNode }).children;
  const list = Array.isArray(children) ? children : [children];
  for (let i = 0; i < list.length; i++) {
    const rest = pathTo(list[i] as ReactNode, target, i);
    if (rest) return [here, ...rest];
  }
  return null;
}

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
  raceLost: null,
  keyNeeded: null,
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
  it("B9: say whose write won and what was replaced, and name each action by the exact value it writes", () => {
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

  it("D30: a value changed again since the notice is named as it is now", () => {
    const changed: ActionPreview = { kind: "useMine", writes: [], refused: { reason: "changedSince" }, current: [{ key: `e/${ID}/amount`, value: "33.00" }] };
    expect(actionLabel(amountClash, changed)).toBe("Use mine");
    expect(refusalText(changed, amountClash)).toBe("It changed again since: now Groceries · amount is 33.00. Yours isn't put back over it.");
    const balance: ActionPreview = {
      kind: "useMine",
      writes: [],
      refused: { reason: "changedSince" },
      current: [
        { key: `emi/${EMI}/remainingAsOf`, value: "7000.00" },
        { key: `emi/${EMI}/asOfDate`, value: "2026-07-05" },
      ],
    };
    expect(refusalText(balance, payment)).toBe("It changed again since: now 7000.00 remaining as of 2026-07-05. Yours isn't put back over it.");
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
    expect(reviewText({ noticeCount: 2, leftBehindCount: 1, leftBehindOwnCount: 0 })).toBe("3 to review");
    // This device's own groups are shown outside the toggle (finding 2).
    expect(reviewText({ noticeCount: 2, leftBehindCount: 3, leftBehindOwnCount: 1 })).toBe("4 to review");
    expect(reviewText({ noticeCount: 0, leftBehindCount: 1, leftBehindOwnCount: 1 })).toBeNull();
  });

  it("left-behind changes and a re-apply's result", () => {
    const add = { kind: "add" as const, coll: "e" as const, id: ID, record: { id: ID, remarks: "Taxi", amount: "20.00" }, fields: { amount: "20.00" }, month: "2026-05" };
    expect(leftBehindItemText(add)).toBe("Added Taxi (20.00) in May 2026");
    expect(leftBehindItemText({ kind: "edit", coll: "e", id: ID, record: { id: ID, remarks: "Bus" }, fields: { amount: "3.00" } })).toBe("Changed Bus: amount 3.00");
    expect(leftBehindItemText({ kind: "delete", coll: "debt", id: ID, record: { id: ID, name: "Sam" } })).toBe("Deleted Sam");
    expect(leftBehindItemText({ kind: "unit", key: "lk/2026-05", value: true })).toBe("the lock on May 2026: locked");
    expect(reapplyText({ applied: [add], skipped: [] })).toBe("Re-applied 1 change.");
    // Each collection by its own name field, as a notice names it: an EMI
    // by its card or bank (its remarks are often ""), a subscription by its
    // service, never another collection's field.
    const emi = { kind: "add" as const, coll: "emi" as const, id: EMI, record: { id: EMI, cardOrBank: "Car Loan", remarks: "", emiAmount: "1000.00" }, fields: {} };
    expect(leftBehindItemText(emi)).toBe("Added Car Loan (1000.00)");
    const sub = { kind: "delete" as const, coll: "sub" as const, id: ID, record: { id: ID, service: "Music", cardOrBank: "Card A", amount: "199.00" } };
    expect(leftBehindItemText(sub)).toBe("Deleted Music");
    expect(leftBehindItemText({ kind: "edit", coll: "emi", id: EMI, record: { id: EMI, cardOrBank: "Car Loan", remarks: "x" }, fields: { dueDay: 5 } })).toBe("Changed Car Loan: due day 5");
    expect(reapplyText({ applied: [], skipped: [{ item: emi, reason: "moduleOff" }, { item: sub, reason: "notInLedger" }] })).toBe(
      "Re-applied 0 changes. Skipped: Added Car Loan (1000.00) (its section is turned off); Deleted Music (isn't in the restored ledger).",
    );
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
    const node = NoticeList({ notices: [amountClash, deleted, payment], work: { busy: null, errors: {} }, onAction: (key, action) => calls.push(`${action.kind} ${key}`), onDismiss: (key) => calls.push(`dismiss ${key}`) });
    button(node, "Use 10.00").props.onClick();
    button(node, "Add it back as a new entry: Groceries, 45.00").props.onClick();
    button(node, /^Record again: pay 1000.00/).props.onClick();
    const useMine = button(node, "Use mine");
    expect(useMine.props.disabled).toBe(true);
    // Described by the notice's sentence, and by the reason when refused (finding 9).
    expect(useMine.props["aria-describedby"]).toBe("sync-notice-2-text sync-notice-2-useMine-why");
    expect(button(node, "Use 10.00").props["aria-describedby"]).toBe("sync-notice-0-text");
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

  it("finding 8: while any action runs, every button in the lists is disabled, not just that item's", () => {
    const work = { busy: deleted.key, errors: {} };
    const notices = NoticeList({ notices: [amountClash, deleted], work, onAction: () => {}, onDismiss: () => {} });
    const buttons = elements(notices).filter((el) => el.type === "button");
    expect(buttons.length).toBeGreaterThan(2);
    for (const b of buttons) expect((b.props as { disabled?: boolean }).disabled, text(b)).toBe(true);
    const groups = LeftBehindList({ groups: [group(true, A), group(false, B)], work, onReapply: () => {}, onDiscard: () => {} });
    for (const b of elements(groups).filter((el) => el.type === "button")) expect((b.props as { disabled?: boolean }).disabled, text(b)).toBe(true);
  });
});

/** A left-behind group: this device's own (Taxi) or another's (Bus). */
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

/** A context value for SyncLayers, with actions that do nothing. */
function contextValue(state: Partial<EngineState>, notices: NoticeView[], leftBehind: LeftBehindView[]): SyncStateValue {
  return { ...STATE, ...state, notices, leftBehind, syncNow: async () => {}, noticeAction: async () => {}, dismissNotice: async () => {}, reapply: async () => ({ applied: [], skipped: [] }), discard: async () => {} };
}

describe("SyncPanel: this device's own left-behind changes (D18, section 9.3 step 5, finding 2)", () => {
  it("shows them at once, outside the review toggle, which counts only notices and other devices' groups", () => {
    const value = contextValue({ noticeCount: 1, leftBehindCount: 2, leftBehindOwnCount: 1 }, [amountClash], [group(true, A), group(false, B)]);
    const html = renderToString(SyncLayers({ value, revision: 0, bar: createElement(SyncPanel) }));
    expect(html).toContain("kai restored a backup on");
    expect(html).toContain("1 change made on this device wasn&#x27;t in it.");
    expect(html).toContain("Added Taxi (20.00) in May 2026");
    // Before the status line and its toggle, with its own buttons.
    expect(html.indexOf("Added Taxi")).toBeLessThan(html.indexOf("to review"));
    expect(html.indexOf("Re-apply")).toBeLessThan(html.indexOf("to review"));
    expect(html).toContain("2 to review");
    // Other devices' groups and the notices stay behind the closed toggle.
    const review = html.slice(html.indexOf("<section"));
    expect(review).toMatch(/^<section[^>]* hidden=""/);
    expect(html.slice(0, html.indexOf("<section"))).not.toContain("Added Bus");
    expect(html.slice(0, html.indexOf("<section"))).not.toContain("Use 10.00");
    expect(review).toContain("Added Bus");
  });

  it("with only own groups there is nothing behind the toggle", () => {
    const value = contextValue({ leftBehindCount: 1, leftBehindOwnCount: 1 }, [], [group(true, A)]);
    const html = renderToString(SyncLayers({ value, revision: 0, bar: createElement(SyncPanel) }));
    expect(html).toContain("Added Taxi");
    expect(html).not.toContain("to review");
  });
});

describe("a group's heading", () => {
  it("names a ledger started at the same moment (a racing create's join, D32), not a backup restored", () => {
    const into = { epoch: "e000001-ffffffff", by: "sam", at: Date.UTC(2026, 9, 15) };
    expect(leftBehindHeading(group(true, A, { into }))).toMatch(/^sam started the ledger in the repo on .+. 1 change made on this device wasn't in it.$/);
    expect(leftBehindHeading(group(false, B, { into }))).toMatch(/^1 change from sam wasn't in the ledger sam started on .+.$/);
    expect(leftBehindHeading(group(true, A))).toContain("kai restored a backup on");
  });
});

describe("accessibility (finding 9)", () => {
  it("the toggle controls a list that is always in the page, hidden while closed", () => {
    const value = contextValue({ noticeCount: 1 }, [amountClash], []);
    for (const initiallyOpen of [false, true]) {
      const html = renderToString(SyncLayers({ value, revision: 0, bar: createElement(SyncPanel, { initiallyOpen }) }));
      const controls = /aria-controls="([^"]+)"/.exec(html)![1];
      const section = new RegExp(`<section[^>]*id="${controls.replace(/[^\w-]/g, "\\$&")}"[^>]*>`).exec(html)?.[0];
      expect(section, `open: ${initiallyOpen}`).toBeDefined();
      expect(section!.includes('hidden=""')).toBe(!initiallyOpen);
      expect(html).toContain(`aria-expanded="${initiallyOpen}"`);
    }
  });

  it("each left-behind group's buttons are described by its heading", () => {
    const node = LeftBehindList({ groups: [group(true, A), group(false, B)], work: { busy: null, errors: {} }, idPrefix: "p", onReapply: () => {}, onDiscard: () => {} });
    const html = renderToString(node);
    const described = elements(node)
      .filter((el) => el.type === "button")
      .map((el) => (el.props as { "aria-describedby"?: string })["aria-describedby"]);
    expect(described).toEqual(["p-own-0", "p-own-0", "p-other-0", "p-other-0"]);
    expect(html).toContain('id="p-own-0"');
    expect(html).toContain('id="p-other-0"');
  });

  it("after an action removes its item, focus goes to the next item, else the one before, else the list", () => {
    expect(nextFocus(["a", "b", "c"], "b", ["a", "c"])).toBe("c");
    expect(nextFocus(["a", "b", "c"], "c", ["a", "b"])).toBe("b");
    expect(nextFocus(["a"], "a", [])).toBeNull();
    // Items that arrived since: the next of those it knew, in order.
    expect(nextFocus(["a", "b", "c"], "a", ["x", "c"])).toBe("c");
  });
});

describe("sync.css (finding 10)", () => {
  /** Every declaration the stylesheet gives `selector`, comments left out. */
  function rulesFor(selector: string): string {
    const css = syncCss.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, selectors]) => selectors.split(",").some((part: string) => part.trim() === selector))
      .map(([, , body]) => body)
      .join(";");
  }

  it("lets the long values a notice or button names wrap at phone width, never widen the page", () => {
    for (const selector of [".sync-review-text", ".sync-review-reason", ".sync-review-note", ".sync-review-done", ".sync-review-error", ".sync-review-changes", ".sync-review button", ".sync-message-line", ".sync-status > span"]) {
      expect(rulesFor(selector), selector).toMatch(/overflow-wrap:\s*anywhere/);
    }
    for (const selector of [".sync-review-action", ".sync-review-reason", ".sync-review-changes", ".sync-review button", ".sync-status > span"]) {
      expect(rulesFor(selector), selector).toMatch(/min-width:\s*0/);
    }
  });
});

describe("LeftBehindList (D18)", () => {
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

    const html = renderToString(createElement(SyncHost, { engine, bar: createElement(SyncPanel, { initiallyOpen: true }) }, createElement("main", null, "The ledger")));
    expect(html).toContain("1 to review");
    expect(html).toContain("sam changed Groceries · amount to 12.00; your 10.00 was replaced.");
    expect(html).toContain("Use 10.00");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("The ledger");
    const closed = renderToString(createElement(SyncHost, { engine, bar: createElement(SyncPanel) }));
    expect(closed).toContain('aria-expanded="false"');
  });

  it("finding 1: the bar keeps its place across a remote join, so the panel's open list and done message survive it", async () => {
    // No DOM here, so this checks what React keys state on: an element keeps
    // its state while the type and key at every level above it stay the
    // same. The bar's path must not change when the revision does; the
    // children's must (they read the ledger again).
    const engine = new SyncEngine({ key: await testKey(), actor: "alex", store: new MemoryStore(), locks: null, log: () => {} });
    running.push(engine);
    await engine.start();
    await engine.initialize("e000001-0000000a", genesisState(emptyDocument()));
    const before = engine.getState().revision;
    const sam = new Replica(B, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry({ year: 2026, month: 5, amount: 12, remarks: "Bus", category: "transportation", isCard: false });
    await engine.join({ ops: sam.ops.map((op): [string, Op] => [B, op]) });
    const after = engine.getState().revision;
    expect(after).not.toBe(before);

    const bar = createElement(SyncPanel, { initiallyOpen: true });
    const page = createElement("main", null, "The ledger");
    const value = { ...engine.getState(), notices: [], leftBehind: [], syncNow: async () => {}, noticeAction: async () => {}, dismissNotice: async () => {}, reapply: async () => ({ applied: [], skipped: [] }), discard: async () => {} };
    const tree = (revision: number) => SyncLayers({ value, revision, bar, children: page });
    expect(pathTo(tree(after), bar)).toEqual(pathTo(tree(before), bar));
    expect(pathTo(tree(after), page)).not.toEqual(pathTo(tree(before), page));
    // The context is above the bar: the panel reads it there.
    expect(renderToString(createElement(SyncHost, { engine, bar }))).toContain("Saved");
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
