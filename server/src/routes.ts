import { Router, type ErrorRequestHandler } from "express";
import { appendEntry, deleteEntry, LedgerError, listMonth, moveEntry, updateEntry, yearSummary } from "./excel/ledger.js";
import { loadCategoryConfig } from "./excel/categoryColors.js";
import { financeSummary, getMonthIncome, setMonthIncome } from "./excel/finances.js";
import { addDebt, deleteDebt, listDebts, updateDebt } from "./excel/debts.js";
import { getMonthBills, setMonthBills, yearBillsSummary, type CardBill } from "./excel/creditCardBills.js";
import {
  addEmi,
  deleteEmi,
  emiMonthlyProjection,
  listEmis,
  recordEmiPayment,
  updateEmi,
  type EmiEditsInput,
} from "./excel/emi.js";
import {
  addSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  type SubscriptionEditsInput,
} from "./excel/subscriptions.js";
import { dashboardOverview } from "./excel/overview.js";

export const router = Router();

router.get("/categories", async (_req, res, next) => {
  try {
    res.json(await loadCategoryConfig());
  } catch (err) {
    next(err);
  }
});

router.get("/months/:year/:month", async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    const entries = await listMonth(year, month);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

router.get("/summary/:year", async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const summary = await yearSummary(year);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.post("/entries", async (req, res, next) => {
  try {
    const { year, month, amount, remarks, category, isCard } = req.body ?? {};
    const entry = await appendEntry({
      year: Number(year),
      month: Number(month),
      amount: Number(amount),
      remarks: String(remarks ?? ""),
      category,
      isCard: Boolean(isCard),
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

router.put("/entries/:year/:month/:row", async (req, res, next) => {
  try {
    const { amount, remarks, category, isCard } = req.body ?? {};
    const entry = await updateEntry({
      year: Number(req.params.year),
      month: Number(req.params.month),
      row: Number(req.params.row),
      amount: Number(amount),
      remarks: String(remarks ?? ""),
      category,
      isCard: Boolean(isCard),
    });
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.delete("/entries/:year/:month/:row", async (req, res, next) => {
  try {
    await deleteEntry({
      year: Number(req.params.year),
      month: Number(req.params.month),
      row: Number(req.params.row),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.patch("/entries/:year/:month/:row/move", async (req, res, next) => {
  try {
    const { toRow } = req.body ?? {};
    await moveEntry({
      year: Number(req.params.year),
      month: Number(req.params.month),
      fromRow: Number(req.params.row),
      toRow: Number(toRow),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/finance/:year/:month", async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    const income = await getMonthIncome(year, month);
    res.json(income);
  } catch (err) {
    next(err);
  }
});

function parseAmountField(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function parseSavingsField(value: unknown): { name: string; amount: number }[] {
  if (!Array.isArray(value)) return [];
  return value.map((e) => ({ name: String(e?.name ?? ""), amount: Number(e?.amount) }));
}

router.put("/finance/:year/:month", async (req, res, next) => {
  try {
    const { salary, otherIncome, savings } = req.body ?? {};
    const income = await setMonthIncome({
      year: Number(req.params.year),
      month: Number(req.params.month),
      salary: parseAmountField(salary),
      otherIncome: parseAmountField(otherIncome),
      savings: parseSavingsField(savings),
    });
    res.json(income);
  } catch (err) {
    next(err);
  }
});

router.get("/finance-summary/:year", async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const summary = await financeSummary(year, 12);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/debts", async (_req, res, next) => {
  try {
    const debts = await listDebts();
    res.json(debts);
  } catch (err) {
    next(err);
  }
});

router.post("/debts", async (req, res, next) => {
  try {
    const { name, amount } = req.body ?? {};
    const entry = await addDebt({ name: String(name ?? ""), amount: Number(amount) });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

router.put("/debts/:row", async (req, res, next) => {
  try {
    const { name, amount } = req.body ?? {};
    const entry = await updateDebt({ row: Number(req.params.row), name: String(name ?? ""), amount: Number(amount) });
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.delete("/debts/:row", async (req, res, next) => {
  try {
    await deleteDebt(Number(req.params.row));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function parseCardsField(value: unknown): CardBill[] {
  if (!Array.isArray(value)) return [];
  return value.map((c) => ({
    name: String(c?.name ?? ""),
    due: Number(c?.due),
    paid: Number(c?.paid),
    dueDate: c?.dueDate === null || c?.dueDate === undefined || c?.dueDate === "" ? null : String(c.dueDate),
    settled: c?.settled === true,
  }));
}

router.get("/credit-card-bills/:year/:month", async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    const bills = await getMonthBills(year, month);
    res.json(bills);
  } catch (err) {
    next(err);
  }
});

router.put("/credit-card-bills/:year/:month", async (req, res, next) => {
  try {
    const { cards } = req.body ?? {};
    const bills = await setMonthBills({
      year: Number(req.params.year),
      month: Number(req.params.month),
      cards: parseCardsField(cards),
    });
    res.json(bills);
  } catch (err) {
    next(err);
  }
});

router.get("/credit-card-bills-summary/:year", async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const summary = await yearBillsSummary(year);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

function parseEmiInput(body: unknown): EmiEditsInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    cardOrBank: String(b.cardOrBank ?? ""),
    emiAmount: Number(b.emiAmount),
    dueDay: Number(b.dueDay),
    totalAmount: Number(b.totalAmount),
    remarks: String(b.remarks ?? ""),
    remainingAsOf: Number(b.remainingAsOf),
    durationMonths: b.durationMonths === null || b.durationMonths === undefined ? null : Number(b.durationMonths),
  };
}

router.get("/emi", async (_req, res, next) => {
  try {
    res.json(await listEmis());
  } catch (err) {
    next(err);
  }
});

router.post("/emi", async (req, res, next) => {
  try {
    const entry = await addEmi(parseEmiInput(req.body));
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

router.put("/emi/:row", async (req, res, next) => {
  try {
    const entry = await updateEmi(Number(req.params.row), parseEmiInput(req.body));
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.delete("/emi/:row", async (req, res, next) => {
  try {
    await deleteEmi(Number(req.params.row));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.patch("/emi/:row/pay", async (req, res, next) => {
  try {
    const { amount } = req.body ?? {};
    const entry = await recordEmiPayment(Number(req.params.row), Number(amount));
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.get("/emi-monthly-projection", async (_req, res, next) => {
  try {
    res.json(await emiMonthlyProjection());
  } catch (err) {
    next(err);
  }
});

function parseSubscriptionInput(body: unknown): SubscriptionEditsInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    service: String(b.service ?? ""),
    amount: Number(b.amount),
    duration: b.duration as SubscriptionEditsInput["duration"],
    expiryAnchor: String(b.expiryAnchor ?? ""),
    cardOrBank: String(b.cardOrBank ?? ""),
  };
}

router.get("/subscriptions", async (_req, res, next) => {
  try {
    res.json(await listSubscriptions());
  } catch (err) {
    next(err);
  }
});

router.post("/subscriptions", async (req, res, next) => {
  try {
    const entry = await addSubscription(parseSubscriptionInput(req.body));
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

router.put("/subscriptions/:row", async (req, res, next) => {
  try {
    const entry = await updateSubscription(Number(req.params.row), parseSubscriptionInput(req.body));
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.delete("/subscriptions/:row", async (req, res, next) => {
  try {
    await deleteSubscription(Number(req.params.row));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/overview", async (_req, res, next) => {
  try {
    res.json(await dashboardOverview());
  } catch (err) {
    next(err);
  }
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

router.use(errorHandler);
