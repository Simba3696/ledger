import { Router, type ErrorRequestHandler } from "express";
import { appendEntry, deleteEntry, LedgerError, listMonth, moveEntry, updateEntry, yearSummary } from "./excel/ledger.js";
import { CATEGORIES, CATEGORY_LABELS } from "./excel/categoryColors.js";

export const router = Router();

router.get("/categories", (_req, res) => {
  res.json(CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] })));
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

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

router.use(errorHandler);
