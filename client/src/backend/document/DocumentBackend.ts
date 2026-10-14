import { LedgerError } from "@ledger/shared/errors";
import { todayInAppZone } from "@ledger/shared/today";
import type {
  AppConfig,
  CardBill,
  CategoryOption,
  DashboardOverview,
  DebtEdits,
  DebtEntry,
  EmiEdits,
  EmiEntryComputed,
  EmiMonthlyProjection,
  EmiProjectionScale,
  EntryEdits,
  IncomeEdits,
  LedgerEntry,
  ModuleName,
  MonthBills,
  MonthBillsSummary,
  MonthFinanceSummary,
  MonthIncome,
  MonthLock,
  MonthSummary,
  NewEntry,
  SubscriptionEdits,
  SubscriptionEntryComputed,
} from "../../api";
import { ApiError } from "../ApiError";
import type { LedgerBackend } from "../LedgerBackend";
import {
  cardFields,
  debtFields,
  emiFields,
  entryFields,
  incomeFields,
  lockFlag,
  moveTarget,
  pathNumber,
  paymentAmount,
  projectionMonths,
  subscriptionFields,
  wireBody,
} from "./coerce";
import { RowHandles } from "./handles";
import { assertModuleEnabled, canonicalModules } from "./modules";
import * as ops from "./operations";
import type { LedgerDocument } from "./types";

/** Where DocumentBackend's document lives. `current()` is the latest
 * document; `commit(next)` makes `next` the latest, and is called once per
 * successful write with a fresh object. The sync engine (#7) supplies the
 * real host; tests use an in-memory one. */
export interface DocumentHost {
  current(): LedgerDocument;
  commit(next: LedgerDocument): Promise<void>;
  /** Optional: called synchronously when a write is submitted, before it
   * waits behind earlier writes. The write then commits through the
   * returned handle, and `end()` is called once it has settled, whether it
   * committed, failed or made no commit. The sync engine uses it to judge a
   * write by what was on screen when the user saved (design section 3.4). */
  begin?(): HostWrite;
}

/** One submitted write, from `DocumentHost.begin()`. */
export interface HostWrite {
  /** Optional: settles when the write may read the document, once the
   * host's other writers that came first have settled. The sync engine has
   * writes that don't go through DocumentBackend (design section 3.5,
   * `amend`), and a write that read the document while one of those was
   * still saving would set back a whole-unit register it changed. */
  ready?: Promise<void>;
  /** Optional: the copy of `doc` (current(), read at the write's turn) the
   * write changes in place, instead of the whole structuredClone made
   * otherwise. It must read exactly as that clone would, before and after
   * any change, and nothing the write can reach through it may be shared
   * with `doc` or anything else; the write then commits it. The sync engine
   * copies only the parts a write reads (stage 8c-2). */
  draft?(doc: LedgerDocument): LedgerDocument;
  commit(next: LedgerDocument): Promise<void>;
  end(): void;
}

export interface DocumentBackendOptions {
  host: DocumentHost;
  /** Epoch milliseconds: "today" and every record stamp come from here. */
  now: () => number;
  /** Who the stamps name: the GitHub login. */
  actor: string;
  /** A new record id: crypto.randomUUID in the app. */
  newId: () => string;
}

/** The value a caller gets: what it would have parsed from the HTTP
 * response. Fresh (no object shared with the document), with no undefined
 * keys, no -0 and no Date. */
function wire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The status and message app.ts's error handler would have answered with.
 * Anything that isn't a LedgerError is a 500 whose detail goes only to the
 * console, tagged so it can be told apart from the HTTP backend's. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof LedgerError) return new ApiError(err.status, err.message);
  console.error("ledger:document-backend", err);
  return new ApiError(500, "Internal server error");
}

/** "Today" in the document's time zone, or in UTC when this runtime's Intl
 * doesn't know that zone. The document check holds a zone only to its shape
 * (zone lists differ between builds, ADR-0008), so a synced zone this build
 * can't use must not fail every call that needs today. */
function documentToday(now: Date, timeZone: string): Date {
  try {
    return todayInAppZone(now, timeZone);
  } catch (err) {
    if (err instanceof RangeError) return todayInAppZone(now, "UTC");
    throw err;
  }
}

/** The state behind one DocumentBackend: its host, clock, row handles and
 * write queue. Kept apart from the class so the class has exactly the
 * LedgerBackend methods. */
class Session {
  readonly #options: DocumentBackendOptions;
  readonly handles = new RowHandles();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DocumentBackendOptions) {
    this.#options = options;
  }

  /** The context a call runs in. "Today" is worked out only if the call
   * reads it, as the server calls appToday() only where it needs it. */
  #context(doc: LedgerDocument, now: number): ops.ReadContext {
    let today: Date | undefined;
    return {
      doc,
      handles: this.handles,
      get today() {
        today ??= documentToday(new Date(now), doc.settings.timeZone);
        return today;
      },
    };
  }

  /** Runs a read against the current document. `module` null = always on. */
  async read<T>(module: ModuleName | null, run: (ctx: ops.ReadContext) => T): Promise<T> {
    try {
      const doc = this.#options.host.current();
      if (module) assertModuleEnabled(doc.settings.modules, module);
      return wire(run(this.#context(doc, this.#options.now())));
    } catch (err) {
      throw toApiError(err);
    }
  }

  /** Queues a write: one at a time, in call order (the stand-in for the
   * store's per-month advisory locks). It runs on a clone of the current
   * document (the handle's draft, when it offers one) and commits that
   * clone once; if anything throws, nothing is committed and the current
   * document is untouched. A host with begin() hears of the write at the
   * call, before it waits in the queue, and the write reads the document
   * only once the handle is ready. `module` null = always on. */
  write<T>(module: ModuleName | null, run: (ctx: ops.WriteContext) => T): Promise<T> {
    const { host, now, actor, newId } = this.#options;
    let submitted: HostWrite | undefined;
    try {
      submitted = host.begin?.();
    } catch (err) {
      return Promise.reject(toApiError(err));
    }
    const result = this.#queue.then(async () => {
      try {
        if (submitted?.ready) await submitted.ready;
        const current = host.current();
        if (module) assertModuleEnabled(current.settings.modules, module);
        const doc = submitted?.draft ? submitted.draft(current) : structuredClone(current);
        const at = now();
        const value = run(Object.assign(this.#context(doc, at), { now: at, actor, newId }));
        await (submitted ? submitted.commit(doc) : host.commit(doc));
        return wire(value);
      } catch (err) {
        throw toApiError(err);
      } finally {
        submitted?.end();
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/** The LedgerBackend of GitHub storage mode (ADR-0007): all 31 calls served
 * from a LedgerDocument in memory, with no I/O of its own (the host
 * persists). Each call reproduces the HTTP path: the arguments make the
 * JSON and URL round trip, get routes.ts's coercions, then the SQL store's
 * checks in the store's order with its messages, and failures carry the
 * HTTP status the server would have answered with. server/test/parity/
 * holds it to identical results against the SQL store. */
export class DocumentBackend implements LedgerBackend {
  readonly #session: Session;

  constructor(options: DocumentBackendOptions) {
    this.#session = new Session(options);
  }

  /** GitHub mode's Settings (#8): the sections and the time zone. Not a
   * LedgerBackend call (the Supabase build has no equivalent: there they
   * are ENABLED_MODULES and APP_TIMEZONE), and in no section of its own.
   * At least one section, as ENABLED_MODULES can't express none; a time
   * zone the browser knows, since every "today" is reckoned in it. A
   * write like any other, so the sync engine sends it as one op. */
  async updateSettings(patch: Partial<LedgerDocument["settings"]>): Promise<LedgerDocument["settings"]> {
    const modules = patch.modules === undefined ? undefined : canonicalModules(patch.modules);
    if (patch.modules !== undefined) {
      const unknown = patch.modules.filter((m) => !modules!.includes(m));
      if (unknown.length > 0) return Promise.reject(new ApiError(400, `Unknown section: ${unknown.join(", ")}`));
      if (modules!.length === 0) return Promise.reject(new ApiError(400, "Choose at least one section"));
    }
    if (patch.timeZone !== undefined && !knownTimeZone(patch.timeZone)) return Promise.reject(new ApiError(400, `Unknown time zone: ${patch.timeZone}`));
    return this.#session.write(null, ({ doc }) => {
      doc.settings = { modules: modules ?? doc.settings.modules, timeZone: patch.timeZone ?? doc.settings.timeZone };
      return doc.settings;
    });
  }

  async getConfig(): Promise<AppConfig> {
    return this.#session.read(null, ({ doc }) => ({ modules: canonicalModules(doc.settings.modules) }));
  }

  async getCategories(): Promise<CategoryOption[]> {
    return this.#session.read(null, ({ doc }) => ops.listCategories(doc));
  }

  async getMonth(year: number, month: number): Promise<LedgerEntry[]> {
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.read("expenses", (ctx) => ops.listMonth(ctx, y, m));
  }

  async addEntry(entry: NewEntry): Promise<LedgerEntry> {
    const body = wireBody(entry);
    const [y, m] = [Number(body.year), Number(body.month)];
    return this.#session.write("expenses", (ctx) => ops.appendEntry(ctx, y, m, entryFields(body)));
  }

  async updateEntry(year: number, month: number, row: number, edits: EntryEdits): Promise<LedgerEntry> {
    const body = wireBody(edits);
    const [y, m, r] = [pathNumber(year), pathNumber(month), pathNumber(row)];
    return this.#session.write("expenses", (ctx) => ops.updateEntry(ctx, y, m, r, entryFields(body)));
  }

  async deleteEntry(year: number, month: number, row: number): Promise<void> {
    const [y, m, r] = [pathNumber(year), pathNumber(month), pathNumber(row)];
    return this.#session.write("expenses", (ctx) => ops.deleteEntry(ctx, y, m, r));
  }

  async moveEntry(year: number, month: number, fromRow: number, toRow: number): Promise<void> {
    const to = moveTarget(wireBody({ toRow }));
    const [y, m, from] = [pathNumber(year), pathNumber(month), pathNumber(fromRow)];
    return this.#session.write("expenses", (ctx) => ops.moveEntry(ctx, y, m, from, to));
  }

  async getMonthLock(year: number, month: number): Promise<MonthLock> {
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.read("expenses", (ctx) => ({ locked: ops.isMonthLocked(ctx, y, m) }));
  }

  async setMonthLock(year: number, month: number, locked: boolean): Promise<MonthLock> {
    const flag = lockFlag(wireBody({ locked }));
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.write("expenses", (ctx) => {
      ops.setMonthLocked(ctx, y, m, flag);
      return { locked: flag };
    });
  }

  async getYearSummary(year: number): Promise<MonthSummary[]> {
    const y = pathNumber(year);
    return this.#session.read("expenses", (ctx) => ops.yearSummary(ctx, y));
  }

  async getMonthIncome(year: number, month: number): Promise<MonthIncome> {
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.read("finances", (ctx) => ops.getMonthIncome(ctx, y, m));
  }

  async setMonthIncome(year: number, month: number, edits: IncomeEdits): Promise<MonthIncome> {
    const input = incomeFields(wireBody(edits));
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.write("finances", (ctx) => ops.setMonthIncome(ctx, y, m, input));
  }

  async getFinanceSummary(year: number): Promise<MonthFinanceSummary[]> {
    const y = pathNumber(year);
    return this.#session.read("finances", (ctx) => ops.yearFinanceSummary(ctx, y));
  }

  async getDebts(): Promise<DebtEntry[]> {
    return this.#session.read("debts", (ctx) => ops.listDebts(ctx));
  }

  async addDebt(edits: DebtEdits): Promise<DebtEntry> {
    const input = debtFields(wireBody(edits));
    return this.#session.write("debts", (ctx) => ops.addDebt(ctx, input));
  }

  async updateDebt(row: number, edits: DebtEdits): Promise<DebtEntry> {
    const input = debtFields(wireBody(edits));
    const r = pathNumber(row);
    return this.#session.write("debts", (ctx) => ops.updateDebt(ctx, r, input));
  }

  async deleteDebt(row: number): Promise<void> {
    const r = pathNumber(row);
    return this.#session.write("debts", (ctx) => ops.deleteDebt(ctx, r));
  }

  async getMonthBills(year: number, month: number): Promise<MonthBills> {
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.read("credit-cards", (ctx) => ops.getMonthBills(ctx, y, m));
  }

  async setMonthBills(year: number, month: number, cards: CardBill[]): Promise<MonthBills> {
    const input = cardFields(wireBody({ cards }));
    const [y, m] = [pathNumber(year), pathNumber(month)];
    return this.#session.write("credit-cards", (ctx) => ops.setMonthBills(ctx, y, m, input));
  }

  async getCreditCardBillsSummary(year: number): Promise<MonthBillsSummary[]> {
    const y = pathNumber(year);
    return this.#session.read("credit-cards", (ctx) => ops.yearBillsSummary(ctx, y));
  }

  async getEmis(): Promise<EmiEntryComputed[]> {
    return this.#session.read("emi", (ctx) => ops.listEmis(ctx));
  }

  async addEmi(edits: EmiEdits): Promise<EmiEntryComputed> {
    const input = emiFields(wireBody(edits));
    return this.#session.write("emi", (ctx) => ops.addEmi(ctx, input));
  }

  async updateEmi(row: number, edits: EmiEdits): Promise<EmiEntryComputed> {
    const input = emiFields(wireBody(edits));
    const r = pathNumber(row);
    return this.#session.write("emi", (ctx) => ops.updateEmi(ctx, r, input));
  }

  async deleteEmi(row: number): Promise<void> {
    const r = pathNumber(row);
    return this.#session.write("emi", (ctx) => ops.deleteEmi(ctx, r));
  }

  async payEmi(row: number, amount: number): Promise<EmiEntryComputed> {
    const paid = paymentAmount(wireBody({ amount }));
    const r = pathNumber(row);
    return this.#session.write("emi", (ctx) => ops.recordEmiPayment(ctx, r, paid));
  }

  async getEmiMonthlyProjection(months: EmiProjectionScale): Promise<EmiMonthlyProjection[]> {
    const count = projectionMonths(months);
    return this.#session.read("emi", (ctx) => ops.emiMonthlyProjection(ctx, count));
  }

  async getSubscriptions(): Promise<SubscriptionEntryComputed[]> {
    return this.#session.read("subscriptions", (ctx) => ops.listSubscriptions(ctx));
  }

  async addSubscription(edits: SubscriptionEdits): Promise<SubscriptionEntryComputed> {
    const input = subscriptionFields(wireBody(edits));
    return this.#session.write("subscriptions", (ctx) => ops.addSubscription(ctx, input));
  }

  async updateSubscription(row: number, edits: SubscriptionEdits): Promise<SubscriptionEntryComputed> {
    const input = subscriptionFields(wireBody(edits));
    const r = pathNumber(row);
    return this.#session.write("subscriptions", (ctx) => ops.updateSubscription(ctx, r, input));
  }

  async deleteSubscription(row: number): Promise<void> {
    const r = pathNumber(row);
    return this.#session.write("subscriptions", (ctx) => ops.deleteSubscription(ctx, r));
  }

  async getOverview(): Promise<DashboardOverview> {
    return this.#session.read(null, (ctx) => ops.dashboardOverview(ctx, canonicalModules(ctx.doc.settings.modules)));
  }
}

/** A zone name the browser can reckon a date in. */
function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone.trim() !== "";
  } catch {
    return false;
  }
}
