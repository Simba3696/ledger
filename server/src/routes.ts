import { Router } from "express";
import { appendEntry, LedgerError, listMonth } from "./excel/ledger.js";
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: unknown, _req: any, res: any, _next: any) => {
  if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
