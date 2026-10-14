import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ApiError } from "../api";

// Pins the HTTP traffic the Supabase build sends, so moving request() and the
// per-call URLs out of api.ts (LedgerBackend seam, issue #4) can be checked to
// change nothing. Every case goes through api.ts, the module components use.

const session = vi.hoisted(() => ({
  currentAccessToken: vi.fn<() => Promise<string | null>>(),
  expireSession: vi.fn<(notice: string) => Promise<void>>(),
}));
vi.mock("../auth/session", () => session);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  session.currentAccessToken.mockResolvedValue("test-token");
  session.expireSession.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

interface SentRequest {
  url: string;
  method: string | undefined;
  contentType: string | null;
  authorization: string | null;
  body: unknown;
}

function lastRequest(): SentRequest {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init = {}] = fetchMock.mock.calls[0];
  const headers = new Headers(init.headers);
  return {
    url: String(url),
    method: init.method,
    contentType: headers.get("Content-Type"),
    authorization: headers.get("Authorization"),
    body: init.body,
  };
}

const JSON_TYPE = "application/json";
const entry = { year: 2026, month: 3, amount: 120, remarks: "Groceries", category: "Food", isCard: false };
const entryEdits = { amount: 80, remarks: "Fuel", category: "Transport", isCard: true };
const incomeEdits = { salary: 5000, otherIncome: null, savings: [{ name: "Fund A", amount: 1000 }] };
const debtEdits = { name: "Alex", amount: -250 };
const cards = [{ name: "Card A", due: 900, paid: 900, dueDate: "2026-03-15", settled: true }];
const emiEdits = {
  cardOrBank: "Car Loan",
  emiAmount: 300,
  dueDay: 5,
  totalAmount: 7200,
  remarks: "",
  remainingAsOf: 3600,
  durationMonths: 12,
  interestRate: 9.5,
  foreclosureCharge: null,
};
const subscriptionEdits = {
  service: "Music",
  amount: 10,
  duration: "Monthly" as const,
  expiryAnchor: "2026-03-01",
  cardOrBank: "Card A",
};

type Case = [
  name: keyof typeof api,
  call: () => Promise<unknown>,
  expected: { url: string; method?: string; body?: unknown },
];

// One case per api.ts function export. `method` absent means fetch's default
// (GET); `body` present means a JSON body sent with Content-Type JSON.
const cases: Case[] = [
  ["getConfig", () => api.getConfig(), { url: "/api/config" }],
  ["getCategories", () => api.getCategories(), { url: "/api/categories" }],
  ["getMonth", () => api.getMonth(2026, 3), { url: "/api/months/2026/3" }],
  ["addEntry", () => api.addEntry(entry), { url: "/api/entries", method: "POST", body: entry }],
  [
    "updateEntry",
    () => api.updateEntry(2026, 3, 7, entryEdits),
    { url: "/api/entries/2026/3/7", method: "PUT", body: entryEdits },
  ],
  ["deleteEntry", () => api.deleteEntry(2026, 3, 7), { url: "/api/entries/2026/3/7", method: "DELETE" }],
  [
    "moveEntry",
    () => api.moveEntry(2026, 3, 7, 2),
    { url: "/api/entries/2026/3/7/move", method: "PATCH", body: { toRow: 2 } },
  ],
  ["getMonthLock", () => api.getMonthLock(2026, 3), { url: "/api/months/2026/3/lock" }],
  [
    "setMonthLock",
    () => api.setMonthLock(2026, 3, true),
    { url: "/api/months/2026/3/lock", method: "PUT", body: { locked: true } },
  ],
  ["getYearSummary", () => api.getYearSummary(2026), { url: "/api/summary/2026" }],
  ["getMonthIncome", () => api.getMonthIncome(2026, 3), { url: "/api/finance/2026/3" }],
  [
    "setMonthIncome",
    () => api.setMonthIncome(2026, 3, incomeEdits),
    { url: "/api/finance/2026/3", method: "PUT", body: incomeEdits },
  ],
  ["getFinanceSummary", () => api.getFinanceSummary(2026), { url: "/api/finance-summary/2026" }],
  ["getDebts", () => api.getDebts(), { url: "/api/debts" }],
  ["addDebt", () => api.addDebt(debtEdits), { url: "/api/debts", method: "POST", body: debtEdits }],
  ["updateDebt", () => api.updateDebt(4, debtEdits), { url: "/api/debts/4", method: "PUT", body: debtEdits }],
  ["deleteDebt", () => api.deleteDebt(4), { url: "/api/debts/4", method: "DELETE" }],
  ["getMonthBills", () => api.getMonthBills(2026, 3), { url: "/api/credit-card-bills/2026/3" }],
  [
    "setMonthBills",
    () => api.setMonthBills(2026, 3, cards),
    { url: "/api/credit-card-bills/2026/3", method: "PUT", body: { cards } },
  ],
  [
    "getCreditCardBillsSummary",
    () => api.getCreditCardBillsSummary(2026),
    { url: "/api/credit-card-bills-summary/2026" },
  ],
  ["getEmis", () => api.getEmis(), { url: "/api/emi" }],
  ["addEmi", () => api.addEmi(emiEdits), { url: "/api/emi", method: "POST", body: emiEdits }],
  ["updateEmi", () => api.updateEmi(2, emiEdits), { url: "/api/emi/2", method: "PUT", body: emiEdits }],
  ["deleteEmi", () => api.deleteEmi(2), { url: "/api/emi/2", method: "DELETE" }],
  ["payEmi", () => api.payEmi(2, 300), { url: "/api/emi/2/pay", method: "PATCH", body: { amount: 300 } }],
  // No argument: the `months = 12` default lives in api.ts.
  ["getEmiMonthlyProjection", () => api.getEmiMonthlyProjection(), { url: "/api/emi-monthly-projection?months=12" }],
  ["getSubscriptions", () => api.getSubscriptions(), { url: "/api/subscriptions" }],
  [
    "addSubscription",
    () => api.addSubscription(subscriptionEdits),
    { url: "/api/subscriptions", method: "POST", body: subscriptionEdits },
  ],
  [
    "updateSubscription",
    () => api.updateSubscription(9, subscriptionEdits),
    { url: "/api/subscriptions/9", method: "PUT", body: subscriptionEdits },
  ],
  ["deleteSubscription", () => api.deleteSubscription(9), { url: "/api/subscriptions/9", method: "DELETE" }],
  ["getOverview", () => api.getOverview(), { url: "/api/overview" }],
];

// installBackend is where GitHub mode swaps the backend in (#8), not one of
// the backend's calls.
const apiFunctionNames = Object.keys(api)
  .filter((name) => typeof api[name as keyof typeof api] === "function" && name !== "ApiError" && name !== "installBackend")
  .sort();

describe("request shape (one case per api.ts export)", () => {
  it.each(cases)("%s", async (_name, call, expected) => {
    await call();
    const sent = lastRequest();
    expect(sent.url).toBe(expected.url);
    expect(sent.method).toBe(expected.method);
    expect(sent.authorization).toBe("Bearer test-token");
    if (expected.body === undefined) {
      expect(sent.contentType).toBeNull();
      expect(sent.body).toBeUndefined();
    } else {
      expect(sent.contentType).toBe(JSON_TYPE);
      expect(sent.body).toBe(JSON.stringify(expected.body));
    }
  });
});

describe("request()", () => {
  it("sends the bearer token when there is a session", async () => {
    await api.getDebts();
    expect(lastRequest().authorization).toBe("Bearer test-token");
  });

  it("sends no Authorization header without a session", async () => {
    session.currentAccessToken.mockResolvedValue(null);
    await api.getDebts();
    expect(lastRequest().authorization).toBeNull();
  });

  it("expires the session on a 401 with the server's message and throws ApiError(401)", async () => {
    const message = "Your session has expired. Sign in again.";
    fetchMock.mockImplementation(async () => Response.json({ error: message }, { status: 401 }));
    const error = await api.getDebts().catch((e: unknown) => e);
    expect(session.expireSession).toHaveBeenCalledWith(message);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, message });
  });

  it("falls back to statusText when the error body is not JSON", async () => {
    fetchMock.mockImplementation(
      async () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const error = await api.getDebts().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, message: "Bad Gateway" });
    expect(session.expireSession).not.toHaveBeenCalled();
  });

  it("resolves a 204 to undefined without reading a body", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(api.deleteDebt(4)).resolves.toBeUndefined();
  });
});

describe("surface", () => {
  // Looked up by glob, not imported, so this file could land (and pass)
  // before HttpBackend.ts existed and pin the old api.ts's traffic first.
  const backendModules = import.meta.glob<{ httpBackend: { getDebts(): Promise<unknown> } }>("./HttpBackend.ts", {
    eager: true,
  });

  it("api.ts exports exactly the 31 functions httpBackend implements", () => {
    expect(apiFunctionNames).toEqual(cases.map(([name]) => name).sort());
    expect(apiFunctionNames).toHaveLength(31);
    for (const mod of Object.values(backendModules)) {
      expect(Object.keys(mod.httpBackend).sort()).toEqual(apiFunctionNames);
    }
  });

  it("the ApiError api.ts re-exports is the class a failed backend call throws", async () => {
    const message = "This month is locked.";
    fetchMock.mockImplementation(async () => Response.json({ error: message }, { status: 403 }));
    const thrown = [await api.setMonthLock(2026, 3, false).catch((e: unknown) => e)];
    for (const mod of Object.values(backendModules)) {
      thrown.push(await mod.httpBackend.getDebts().catch((e: unknown) => e));
    }
    for (const error of thrown) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ name: "ApiError", status: 403, message });
    }
  });
});
