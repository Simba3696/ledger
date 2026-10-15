// The SQL store as a LedgerBackend, for the parity suite only: each method
// sends the request HttpBackend sends (client/src/backend/HttpBackend.ts:
// same method, path and JSON body) to createApp() through supertest. Going
// over HTTP keeps routes.ts's coercions, the module gate and app.ts's error
// mapping inside what the suite compares. A non-2xx response rejects with an
// ApiError of that status and the body's `error`, as HttpBackend's does.
import type { Express } from "express";
import request from "supertest";
import { ApiError } from "../../../client/src/backend/ApiError";
import type { LedgerBackend } from "../../../client/src/backend/LedgerBackend";

type Method = "get" | "post" | "put" | "patch" | "delete";

export function sqlBackend(app: () => Express): LedgerBackend {
  async function call<T>(method: Method, url: string, body?: unknown): Promise<T> {
    let req = request(app())[method](url);
    // HttpBackend sends JSON.stringify(body); undefined means no body at all.
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined) req = req.set("Content-Type", "application/json").send(text);
    const res = await req;
    if (res.status < 200 || res.status >= 300) {
      let message: string | undefined;
      try {
        message = (JSON.parse(res.text) as { error?: string }).error;
      } catch {
        message = undefined;
      }
      throw new ApiError(res.status, message ?? `Request failed (${res.status})`);
    }
    if (res.status === 204) return undefined as T;
    return JSON.parse(res.text) as T;
  }

  const base = "/api";
  return {
    getConfig: () => call("get", `${base}/config`),
    getCategories: () => call("get", `${base}/categories`),
    getMonth: (year, month) => call("get", `${base}/months/${year}/${month}`),
    addEntry: (entry) => call("post", `${base}/entries`, entry),
    updateEntry: (year, month, row, edits) => call("put", `${base}/entries/${year}/${month}/${row}`, edits),
    deleteEntry: (year, month, row) => call("delete", `${base}/entries/${year}/${month}/${row}`),
    moveEntry: (year, month, fromRow, toRow) => call("patch", `${base}/entries/${year}/${month}/${fromRow}/move`, { toRow }),
    getMonthLock: (year, month) => call("get", `${base}/months/${year}/${month}/lock`),
    setMonthLock: (year, month, locked) => call("put", `${base}/months/${year}/${month}/lock`, { locked }),
    getYearSummary: (year) => call("get", `${base}/summary/${year}`),
    getMonthIncome: (year, month) => call("get", `${base}/finance/${year}/${month}`),
    setMonthIncome: (year, month, edits) => call("put", `${base}/finance/${year}/${month}`, edits),
    getFinanceSummary: (year) => call("get", `${base}/finance-summary/${year}`),
    getDebts: () => call("get", `${base}/debts`),
    addDebt: (edits) => call("post", `${base}/debts`, edits),
    updateDebt: (row, edits) => call("put", `${base}/debts/${row}`, edits),
    deleteDebt: (row) => call("delete", `${base}/debts/${row}`),
    getMonthBills: (year, month) => call("get", `${base}/credit-card-bills/${year}/${month}`),
    setMonthBills: (year, month, cards) => call("put", `${base}/credit-card-bills/${year}/${month}`, { cards }),
    getCreditCardBillsSummary: (year) => call("get", `${base}/credit-card-bills-summary/${year}`),
    getEmis: () => call("get", `${base}/emi`),
    addEmi: (edits) => call("post", `${base}/emi`, edits),
    updateEmi: (row, edits) => call("put", `${base}/emi/${row}`, edits),
    deleteEmi: (row) => call("delete", `${base}/emi/${row}`),
    payEmi: (row, amount) => call("patch", `${base}/emi/${row}/pay`, { amount }),
    getEmiMonthlyProjection: (months) => call("get", `${base}/emi-monthly-projection?months=${months}`),
    getSubscriptions: () => call("get", `${base}/subscriptions`),
    addSubscription: (edits) => call("post", `${base}/subscriptions`, edits),
    updateSubscription: (row, edits) => call("put", `${base}/subscriptions/${row}`, edits),
    deleteSubscription: (row) => call("delete", `${base}/subscriptions/${row}`),
    getOverview: () => call("get", `${base}/overview`),
  };
}
