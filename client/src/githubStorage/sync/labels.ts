import type { LeftBehindItem, ReapplyResult } from "../../backend/sync/leftBehind";
import { REFUSALS, type ActionPreview, type NoticeView } from "../../backend/sync/noticeActions";
import { parseRegisterKey } from "../../backend/sync/keys";
import { DEVICE_SAVE_FAILED, LEDGER_UPDATED, OTHER_TAB, type EngineState, type LeftBehindView } from "../../backend/sync/SyncEngine";

// The words of GitHub mode's sync UI (#7 stage 7): the status line, the
// notices and what their buttons write, and the changes a restore left
// behind. Plain functions, so every sentence is tested without a DOM.
// Values are shown as stored ("12.00"), so a button names exactly what it
// writes.

const FIELD_LABEL: Record<string, string> = {
  amount: "amount",
  remarks: "remarks",
  category: "category",
  cardNote: "card",
  name: "name",
  cardOrBank: "card or bank",
  emiAmount: "EMI amount",
  dueDay: "due day",
  totalAmount: "total amount",
  remainingAsOf: "remaining",
  asOfDate: "as of",
  untilTarget: "until",
  interestRate: "interest rate",
  foreclosureCharge: "foreclosure charge",
  service: "service",
  duration: "duration",
  expiryAnchor: "expires",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-05" as "May 2026". */
export function monthLabel(key: string): string {
  const dash = key.lastIndexOf("-");
  return `${MONTHS[Number(key.slice(dash + 1)) - 1] ?? key.slice(dash + 1)} ${key.slice(0, dash)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored value as text, exactly as it would be written. */
export function valueText(key: string, value: unknown): string {
  const parsed = parseRegisterKey(key);
  if (parsed?.kind === "month" && parsed.family === "lk") return value === true ? "locked" : "unlocked";
  if (parsed?.kind === "month" && parsed.family === "fm") {
    if (!isObject(value)) return "nothing entered";
    const savings = Array.isArray(value.savings) ? value.savings.map((s: { name?: unknown; amount?: unknown }) => `${String(s.name)} ${String(s.amount)}`) : [];
    return [`salary ${value.salary ?? "-"}`, `other income ${value.otherIncome ?? "-"}`, ...(savings.length > 0 ? [`savings ${savings.join(", ")}`] : [])].join(", ");
  }
  if (parsed?.kind === "month" && parsed.family === "cb") {
    if (!Array.isArray(value) || value.length === 0) return "no cards";
    return value.map((card: Record<string, unknown>) => `${String(card.name)}: due ${String(card.due)}, paid ${String(card.paid)}${card.settled ? ", settled" : ""}`).join("; ");
  }
  if (parsed?.kind === "setting" && parsed.name === "modules") return Array.isArray(value) && value.length > 0 ? value.join(", ") : "none";
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** What a register is, for a sentence: "Groceries · amount", "the
 * finances for May 2026", "the time zone". */
function registerLabel(key: string, names: Record<string, string | null>): string {
  const parsed = parseRegisterKey(key);
  if (parsed === null) return key;
  if (parsed.kind === "field") return `${names[`${parsed.coll}/${parsed.id}`] ?? "an entry"} · ${FIELD_LABEL[parsed.field] ?? parsed.field}`;
  if (parsed.kind === "month") {
    const month = monthLabel(parsed.month);
    return parsed.family === "fm" ? `the finances for ${month}` : parsed.family === "cb" ? `the card bills for ${month}` : `the lock on ${month}`;
  }
  if (parsed.kind === "setting") return parsed.name === "modules" ? "which sections are on" : "the time zone";
  return "the categories";
}

const isBalance = (key: string) => key.startsWith("emi/") && (key.endsWith("/remainingAsOf") || key.endsWith("/asOfDate"));

/** A balance pair's values as "8000.00 remaining as of 2026-06-05". */
function balanceText(registers: { key: string; value: unknown }[]): string {
  const remaining = registers.find((r) => r.key.endsWith("/remainingAsOf"))?.value;
  const asOf = registers.find((r) => r.key.endsWith("/asOfDate"))?.value;
  return `${String(remaining)} remaining as of ${String(asOf)}`;
}

/** What a notice says, in one sentence. */
export function noticeText(view: NoticeView): string {
  const { notice, names } = view;
  switch (notice.kind) {
    case "overwrite": {
      const who = notice.winner.by ?? "Another device";
      const [first] = notice.registers;
      if (notice.registers.every((r) => isBalance(r.key))) {
        const name = names[first.key.slice(0, first.key.lastIndexOf("/"))] ?? "an EMI";
        const theirs = balanceText(notice.registers.map((r) => ({ key: r.key, value: r.theirs })));
        const mine = balanceText(notice.registers.map((r) => ({ key: r.key, value: r.mine })));
        return `${who} also recorded a payment or balance on ${name} (${theirs}); yours (${mine}) was replaced.`;
      }
      if (notice.registers.length === 1) {
        if (first.key.startsWith("lk/")) {
          return `${who} ${first.theirs === true ? "locked" : "unlocked"} ${monthLabel(first.key.slice(3))}; your ${first.mine === true ? "lock" : "unlock"} was replaced.`;
        }
        return `${who} changed ${registerLabel(first.key, names)} to ${valueText(first.key, first.theirs)}; your ${valueText(first.key, first.mine)} was replaced.`;
      }
      const what = notice.registers.map((r) => `${registerLabel(r.key, names)} to ${valueText(r.key, r.theirs)} (yours: ${valueText(r.key, r.mine)})`).join("; ");
      return `${who} changed ${what}. Yours were replaced.`;
    }
    case "deleted": {
      const { target } = notice;
      const name = names[`${target.coll}/${target.id}`] ?? target.name ?? "an entry";
      return `${notice.winner.by ?? "Another device"} deleted ${name}${target.month ? ` (${monthLabel(target.month)})` : ""} while you edited it.`;
    }
    case "kept": {
      const what = notice.registers.map((r) => `${registerLabel(r.key, names)} to ${valueText(r.key, r.theirs)}`).join("; ");
      return `Another device changed ${what} just before you saved; its value was kept.`;
    }
    case "replaced":
      return notice.registers.map((r) => `Your ${valueText(r.key, r.mine)} replaced ${valueText(r.key, r.theirs)} from another device for ${registerLabel(r.key, names)}, which you hadn't seen yet.`).join(" ");
    case "rehome":
      return notice.message;
  }
}

/** A button's words: the action and the exact values it writes. */
export function actionLabel(view: NoticeView, action: ActionPreview): string {
  const name = (key: string) => view.names[key.slice(0, key.lastIndexOf("/"))] ?? "the entry";
  switch (action.kind) {
    case "addBack": {
      const amount = action.writes.find((w) => w.key.endsWith("/amount"));
      const first = action.writes[0];
      return `Add it back as a new entry${first ? `: ${name(first.key)}${amount ? `, ${String(amount.value)}` : ""}` : ""}`;
    }
    case "recordAgain":
      return action.refused === null ? `Record again: pay ${action.paid}, leaving ${balanceText(action.writes)}` : "Record again";
    case "useMine": {
      if (action.refused !== null || view.notice.kind !== "overwrite") return "Use mine";
      const registers = view.notice.registers;
      if (registers.every((r) => isBalance(r.key))) return `Use mine: ${balanceText(registers.map((r) => ({ key: r.key, value: r.mine })))}`;
      if (registers.length === 1 && registers[0].key.startsWith("lk/")) return registers[0].mine === true ? "Lock it again" : "Unlock it again";
      if (action.writes.length === 1 && parseRegisterKey(action.writes[0].key)?.kind === "field") return `Use ${valueText(action.writes[0].key, action.writes[0].value)}`;
      return `Use mine: ${action.writes.map((w) => `${registerLabel(w.key, view.names)} ${valueText(w.key, w.value)}`).join("; ")}`;
    }
  }
}

/** Why a button can't be used now. */
export function refusalText(action: ActionPreview): string | null {
  if (action.refused === null) return null;
  return action.refused.detail ?? REFUSALS[action.refused.reason].message;
}

/** One change a restore left behind, in words. */
export function leftBehindItemText(item: LeftBehindItem): string {
  if (item.kind === "unit") return `${registerLabel(item.key, {})}: ${valueText(item.key, item.value)}`;
  const record = item.record as Record<string, unknown>;
  const name = String(record.remarks ?? record.name ?? record.cardOrBank ?? record.service ?? "an entry");
  const amount = record.amount ?? record.emiAmount;
  const where = item.kind === "add" && item.month ? ` in ${monthLabel(item.month)}` : "";
  if (item.kind === "add") return `Added ${name}${amount !== undefined ? ` (${String(amount)})` : ""}${where}`;
  if (item.kind === "delete") return `Deleted ${name}`;
  const fields = Object.entries(item.fields).map(([field, value]) => `${FIELD_LABEL[field] ?? field} ${valueText(field, value)}`);
  return `Changed ${name}: ${fields.join(", ")}`;
}

const SKIPPED: Record<ReapplyResult["skipped"][number]["reason"], string> = {
  notInLedger: "isn't in the restored ledger",
  deleted: "was deleted since",
  monthLocked: "its month is locked",
  moduleOff: "its section is turned off",
};

/** What a re-apply did, in words: what it skipped, and why. */
export function reapplyText(result: ReapplyResult): string {
  const applied = `Re-applied ${result.applied.length} ${result.applied.length === 1 ? "change" : "changes"}.`;
  if (result.skipped.length === 0) return applied;
  return `${applied} Skipped: ${result.skipped.map(({ item, reason }) => `${leftBehindItemText(item)} (${SKIPPED[reason]})`).join("; ")}.`;
}

/** A group's heading: whose changes, and the restore that left them out. */
export function leftBehindHeading(group: LeftBehindView): string {
  const when = new Date(group.into.at).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const count = group.items.length;
  const changes = `${count} ${count === 1 ? "change" : "changes"}`;
  const were = count === 1 ? "wasn't" : "weren't";
  return group.own
    ? `${group.into.by} restored a backup on ${when}. ${changes} made on this device ${were} in it.`
    : `${changes} from ${group.who ?? "another device"} ${were} in ${group.into.by}'s restore on ${when}.`;
}

/** The status line, as section 11's statuses read. */
export function statusText(state: Pick<EngineState, "status" | "pendingCount" | "deviceSaveFailed">): string {
  // A failed save on this device outranks the rest: the write was refused.
  if (state.deviceSaveFailed) return DEVICE_SAVE_FAILED;
  const n = state.pendingCount;
  switch (state.status) {
    case "locked":
      return OTHER_TAB;
    case "unreadable":
      return "The changes saved on this device can't be read.";
    case "needsToken":
      return "Needs attention: GitHub access needs renewing.";
    case "needsPassphrase":
      return "Needs attention: the ledger can't be opened with this passphrase.";
    case "missing":
      return "Needs attention: the ledger isn't in the GitHub repo.";
    case "needsUpdate":
      return LEDGER_UPDATED;
    case "needsAttention":
      return "Changes from one device can't be read. Everything else keeps syncing.";
    case "pending":
      return n > 0 ? `Offline, ${n} ${n === 1 ? "change" : "changes"} not saved yet` : "Offline";
    case "saving":
      return "Saving...";
    case "idle":
      return n > 0 ? "Saving..." : "Saved";
  }
}

/** "3 to review": notices plus groups a restore left behind, or null. */
export function reviewText(state: Pick<EngineState, "noticeCount" | "leftBehindCount">): string | null {
  const n = state.noticeCount + state.leftBehindCount;
  return n > 0 ? `${n} to review` : null;
}
