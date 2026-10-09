// The backend parity harness (issue #5, LLD §10). parity(title, fixture,
// scenario) plants the fixture in the local Postgres and in a document, runs
// the same scenario against the SQL store (over HTTP) and DocumentBackend,
// records every call's result or { status, message }, and requires the two
// transcripts to be identical.
//
// - The document side's raw results are compared with the HTTP side's
//   JSON-parsed ones, with toStrictEqual. Success statuses (200, 201, 204)
//   are not compared; error statuses are.
// - Each backend's `row` numbers are relabelled by first appearance, per
//   kind of record (expense, debt, EMI, subscription), in results and inside
//   error messages: the SQL side's ids are identity values, the document
//   side's are handles from one counter.
// - The clock is pinned (fake Date) and APP_TIMEZONE is stubbed to the
//   document's time zone, so "today" is the same on both sides.
import { closeSql } from "../dbHelpers.js";
import { afterAll, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import type { ModuleName } from "../../../client/src/api";
import { ApiError } from "../../../client/src/backend/ApiError";
import type { LedgerBackend } from "../../../client/src/backend/LedgerBackend";
import { monthKey } from "../../../client/src/backend/document/types";
import { documentSide } from "./documentBackend";
import { seedSql, type Fixture, type SeedIds } from "./seed";
import { sqlBackend } from "./sqlBackend";

/** The time zone both sides reckon "today" in. */
const TIME_ZONE = "Asia/Kolkata";
/** The day the clock starts on when a fixture doesn't say. */
const DEFAULT_TODAY = "2026-05-10";
/** A row no backend issues in these cases. */
export const MISSING_ID = 999_999;

afterAll(async () => {
  await closeSql();
});

type Side = "sql" | "document";

interface ScenarioContext {
  side: Side;
  /** The rows each seeded record got, by fixture position. */
  ids: {
    expense(year: number, month: number, index: number): number;
    debt(index: number): number;
    emi(index: number): number;
    subscription(index: number): number;
  };
  /** Moves the clock to noon UTC of `day` (YYYY-MM-DD), which is that same
   * calendar day in TIME_ZONE, or to an exact ISO instant. */
  at(day: string): void;
  /** Changes the enabled modules mid-scenario (undefined = all). */
  setModules(modules: ModuleName[] | undefined): Promise<void>;
  /** Adds a derived value to the transcript, for a comparison the raw
   * results can't make (e.g. a set whose order isn't defined). */
  note(label: string, value: unknown): void;
  /** Runs calls without recording them (their order isn't comparable). */
  quietly<T>(run: () => Promise<T>): Promise<T>;
  /** The last call's rejection, or undefined if it succeeded: the recorder
   * resolves a rejected call to undefined, so a scenario asserts on this. */
  lastError(): { status: number; message: string } | undefined;
}

export type Scenario = (backend: LedgerBackend, ctx: ScenarioContext) => Promise<void>;

type Kind = "expense" | "debt" | "emi" | "subscription";

/** Which kind of record a method's `row` fields name. */
const KIND_OF: Partial<Record<keyof LedgerBackend, Kind>> = {
  getMonth: "expense",
  addEntry: "expense",
  updateEntry: "expense",
  deleteEntry: "expense",
  moveEntry: "expense",
  getDebts: "debt",
  addDebt: "debt",
  updateDebt: "debt",
  deleteDebt: "debt",
  getEmis: "emi",
  addEmi: "emi",
  updateEmi: "emi",
  deleteEmi: "emi",
  payEmi: "emi",
  getSubscriptions: "subscription",
  addSubscription: "subscription",
  updateSubscription: "subscription",
  deleteSubscription: "subscription",
};

/** Error messages that quote a row, and the kind of record they name. */
const ROW_MESSAGES: [RegExp, Kind][] = [
  [/^(No entry found at row )(\S+)( in .*)$/s, "expense"],
  [/^(Invalid target row: )(\S+)()$/s, "expense"],
  [/^(No debt entry at row )(\S+)()$/s, "debt"],
  [/^(No EMI entry at row )(\S+)()$/s, "emi"],
  [/^(No subscription at row )(\S+)()$/s, "subscription"],
];

const METHODS: (keyof LedgerBackend)[] = [
  "getConfig", "getCategories", "getMonth", "addEntry", "updateEntry", "deleteEntry", "moveEntry", "getMonthLock",
  "setMonthLock", "getYearSummary", "getMonthIncome", "setMonthIncome", "getFinanceSummary", "getDebts", "addDebt",
  "updateDebt", "deleteDebt", "getMonthBills", "setMonthBills", "getCreditCardBillsSummary", "getEmis", "addEmi",
  "updateEmi", "deleteEmi", "payEmi", "getEmiMonthlyProjection", "getSubscriptions", "addSubscription",
  "updateSubscription", "deleteSubscription", "getOverview",
];

type Entry =
  | { call: keyof LedgerBackend; ok: unknown }
  | { call: keyof LedgerBackend; status: number; message: string }
  | { call: keyof LedgerBackend; unexpected: string }
  | { note: string; value: unknown }
  | { scenarioError: string };

interface Run {
  transcript: Entry[];
  error: unknown;
}

function setClock(day: string): void {
  vi.setSystemTime(new Date(day.length === 10 ? `${day}T12:00:00Z` : day));
}

/** Records every call made through the returned backend, in call order. */
function recorder(
  backend: LedgerBackend,
  transcript: Entry[],
  isQuiet: () => boolean,
  onSettled: (error: { status: number; message: string } | undefined) => void,
): LedgerBackend {
  const wrapped: Partial<Record<keyof LedgerBackend, unknown>> = {};
  for (const name of METHODS) {
    wrapped[name] = async (...args: unknown[]) => {
      const quiet = isQuiet();
      // The slot is taken at call time, so concurrent calls keep call order.
      const slot = quiet ? -1 : transcript.push({ scenarioError: "pending" }) - 1;
      const record = (entry: Entry) => {
        if (slot >= 0) transcript[slot] = entry;
      };
      try {
        const value = await (backend[name] as (...a: unknown[]) => Promise<unknown>)(...args);
        record({ call: name, ok: value === undefined ? undefined : structuredClone(value) });
        onSettled(undefined);
        return value;
      } catch (err) {
        if (err instanceof ApiError) record({ call: name, status: err.status, message: err.message });
        else record({ call: name, unexpected: String(err) });
        onSettled(err instanceof ApiError ? { status: err.status, message: err.message } : { status: -1, message: String(err) });
        return undefined;
      }
    };
  }
  return wrapped as LedgerBackend;
}

/** Replaces row numbers with per-kind labels by first appearance. */
function relabel(transcript: Entry[], seeded: SeedIds): Entry[] {
  const labels = new Map<string, string>();
  const counts: Record<Kind, number> = { expense: 0, debt: 0, emi: 0, subscription: 0 };
  const label = (kind: Kind, row: number) => {
    const key = `${kind}:${row}`;
    let found = labels.get(key);
    if (found === undefined) {
      found = `${kind}#${++counts[kind]}`;
      labels.set(key, found);
    }
    return found;
  };
  for (const rows of seeded.expenses.values()) rows.forEach((r) => label("expense", r));
  seeded.debts.forEach((r) => label("debt", r));
  seeded.emis.forEach((r) => label("emi", r));
  seeded.subscriptions.forEach((r) => label("subscription", r));

  const mapRows = (value: unknown, kind: Kind): unknown => {
    if (Array.isArray(value)) return value.map((v) => mapRows(v, kind));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, k === "row" && typeof v === "number" ? label(kind, v) : mapRows(v, kind)]),
      );
    }
    return value;
  };

  return transcript.map((entry) => {
    if ("ok" in entry) {
      const kind = KIND_OF[entry.call];
      return kind ? { ...entry, ok: mapRows(entry.ok, kind) } : entry;
    }
    if ("message" in entry) {
      for (const [pattern, kind] of ROW_MESSAGES) {
        const m = pattern.exec(entry.message);
        if (m && labels.has(`${kind}:${m[2]}`)) return { ...entry, message: `${m[1]}${labels.get(`${kind}:${m[2]}`)}${m[3]}` };
      }
    }
    return entry;
  });
}

async function runSide(side: Side, fixture: Fixture, scenario: Scenario): Promise<Run> {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(fixture.today ?? DEFAULT_TODAY);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_DISABLED", "true");
  vi.stubEnv("APP_TIMEZONE", TIME_ZONE);
  for (const name of ["NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT", "SUPABASE_URL", "OWNER_EMAIL"]) {
    vi.stubEnv(name, undefined);
  }

  const transcript: Entry[] = [];
  let quiet = false;
  let lastError: { status: number; message: string } | undefined;
  let error: unknown;
  try {
    let backend: LedgerBackend;
    let ids: SeedIds;
    let setModules: (modules: ModuleName[] | undefined) => Promise<void>;
    if (side === "sql") {
      ids = await seedSql(fixture);
      let app: Express;
      setModules = async (modules) => {
        vi.stubEnv("ENABLED_MODULES", modules?.join(","));
        app = createApp({ log: () => {} });
      };
      await setModules(fixture.modules);
      backend = sqlBackend(() => app);
    } else {
      const doc = await documentSide(fixture, TIME_ZONE);
      ids = doc.ids;
      backend = doc.backend;
      setModules = async (modules) => doc.setModules(modules);
    }

    const pick = (rows: number[] | undefined, index: number, what: string) => {
      const row = rows?.[index];
      if (row === undefined) throw new Error(`No seeded ${what} at ${index}`);
      return row;
    };
    const ctx: ScenarioContext = {
      side,
      ids: {
        expense: (year, month, index) => pick(ids.expenses.get(monthKey(year, month)), index, "expense"),
        debt: (index) => pick(ids.debts, index, "debt"),
        emi: (index) => pick(ids.emis, index, "EMI"),
        subscription: (index) => pick(ids.subscriptions, index, "subscription"),
      },
      at: setClock,
      setModules,
      note: (label, value) => {
        transcript.push({ note: label, value: structuredClone(value) });
      },
      lastError: () => lastError,
      quietly: async (run) => {
        quiet = true;
        try {
          return await run();
        } finally {
          quiet = false;
        }
      },
    };
    try {
      const recorded = recorder(backend, transcript, () => quiet, (error) => {
        lastError = error;
      });
      await scenario(recorded, ctx);
    } catch (err) {
      error = err;
      transcript.push({ scenarioError: err instanceof Error ? err.message : String(err) });
    }
    return { transcript: relabel(transcript, ids), error };
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
}

/** One parity case: the same fixture and scenario on both backends, with
 * identical transcripts required. A scenario's own `expect` failures (run
 * on both sides) fail the case too. */
export function parity(title: string, fixture: Fixture, scenario: Scenario): void {
  it(title, async () => {
    const sqlRun = await runSide("sql", fixture, scenario);
    const documentRun = await runSide("document", fixture, scenario);
    expect(documentRun.transcript).toStrictEqual(sqlRun.transcript);
    if (sqlRun.error) throw sqlRun.error;
    if (documentRun.error) throw documentRun.error;
  });
}
