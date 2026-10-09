import { currentAccessToken, expireSession } from "../auth/session";
import { ApiError } from "./ApiError";
import type { LedgerBackend } from "./LedgerBackend";

const BASE = "/api";

/** The HTTP backend's single `fetch` boundary, and so the only place the
 * client calls the API (LLD §6). Reads the current session on every call
 * rather than caching a token, since supabase-js refreshes it in the
 * background. A 401 means the session is gone or no longer valid: it is
 * cleared locally, which returns the app to <SignIn/>. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await currentAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const message = body.error ?? `Request failed (${res.status})`;
    if (res.status === 401) await expireSession(message);
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** The REST API as a LedgerBackend: the Supabase build's only backend. Each
 * method builds the request its api.ts function always has. A plain object,
 * not a class, so a method passed around on its own keeps working. */
export const httpBackend: LedgerBackend = {
  getConfig() {
    return request(`${BASE}/config`);
  },
  getCategories() {
    return request(`${BASE}/categories`);
  },
  getMonth(year, month) {
    return request(`${BASE}/months/${year}/${month}`);
  },
  addEntry(entry) {
    return request(`${BASE}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  },
  updateEntry(year, month, row, edits) {
    return request(`${BASE}/entries/${year}/${month}/${row}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  deleteEntry(year, month, row) {
    return request(`${BASE}/entries/${year}/${month}/${row}`, { method: "DELETE" });
  },
  moveEntry(year, month, fromRow, toRow) {
    return request(`${BASE}/entries/${year}/${month}/${fromRow}/move`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toRow }),
    });
  },
  getMonthLock(year, month) {
    return request(`${BASE}/months/${year}/${month}/lock`);
  },
  setMonthLock(year, month, locked) {
    return request(`${BASE}/months/${year}/${month}/lock`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked }),
    });
  },
  getYearSummary(year) {
    return request(`${BASE}/summary/${year}`);
  },
  getMonthIncome(year, month) {
    return request(`${BASE}/finance/${year}/${month}`);
  },
  setMonthIncome(year, month, edits) {
    return request(`${BASE}/finance/${year}/${month}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  getFinanceSummary(year) {
    return request(`${BASE}/finance-summary/${year}`);
  },
  getDebts() {
    return request(`${BASE}/debts`);
  },
  addDebt(edits) {
    return request(`${BASE}/debts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  updateDebt(row, edits) {
    return request(`${BASE}/debts/${row}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  deleteDebt(row) {
    return request(`${BASE}/debts/${row}`, { method: "DELETE" });
  },
  getMonthBills(year, month) {
    return request(`${BASE}/credit-card-bills/${year}/${month}`);
  },
  setMonthBills(year, month, cards) {
    return request(`${BASE}/credit-card-bills/${year}/${month}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards }),
    });
  },
  getCreditCardBillsSummary(year) {
    return request(`${BASE}/credit-card-bills-summary/${year}`);
  },
  getEmis() {
    return request(`${BASE}/emi`);
  },
  addEmi(edits) {
    return request(`${BASE}/emi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  updateEmi(row, edits) {
    return request(`${BASE}/emi/${row}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  deleteEmi(row) {
    return request(`${BASE}/emi/${row}`, { method: "DELETE" });
  },
  payEmi(row, amount) {
    return request(`${BASE}/emi/${row}/pay`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
  },
  getEmiMonthlyProjection(months) {
    return request(`${BASE}/emi-monthly-projection?months=${months}`);
  },
  getSubscriptions() {
    return request(`${BASE}/subscriptions`);
  },
  addSubscription(edits) {
    return request(`${BASE}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  updateSubscription(row, edits) {
    return request(`${BASE}/subscriptions/${row}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    });
  },
  deleteSubscription(row) {
    return request(`${BASE}/subscriptions/${row}`, { method: "DELETE" });
  },
  getOverview() {
    return request(`${BASE}/overview`);
  },
};
