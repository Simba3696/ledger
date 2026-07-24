import { useCallback, useEffect, useState } from "react";
import { getFinanceSummary, getMonthIncome, setMonthIncome, type MonthFinanceSummary } from "../api";
import { rupee } from "../format";
import "./Finances.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  year: number;
  month: number;
}

function formatOrDash(value: number | null): string {
  return value === null ? "—" : rupee.format(value);
}

export function Finances({ year, month }: Props) {
  const [salary, setSalary] = useState("");
  const [otherIncome, setOtherIncome] = useState("");
  const [currentSavings, setCurrentSavings] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thisMonth, setThisMonth] = useState<MonthFinanceSummary | null>(null);

  // Refreshes the computed stats panel only — never the form fields. The form
  // already holds whatever the user just typed/saved, so re-deriving it from a
  // fresh GET here would be redundant at best; worse, if this ran as part of
  // the initial-mount load, a slow response could resolve after the user
  // already started typing and silently wipe their in-progress input.
  const loadStats = useCallback(async (): Promise<void> => {
    try {
      const yearSummary = await getFinanceSummary(year);
      setThisMonth(yearSummary.find((m) => m.month === month) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [year, month]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const [income] = await Promise.all([getMonthIncome(year, month), loadStats()]);
      if (cancelled) return;
      setSalary(income.salary !== null ? String(income.salary) : "");
      setOtherIncome(income.otherIncome !== null ? String(income.otherIncome) : "");
      setCurrentSavings(income.currentSavings !== null ? String(income.currentSavings) : "");
      setLoading(false);
    })().catch((err) => {
      if (!cancelled) {
        setError((err as Error).message);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [year, month, loadStats]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setMonthIncome(year, month, {
        salary: salary.trim() === "" ? null : Number(salary),
        otherIncome: otherIncome.trim() === "" ? null : Number(otherIncome),
        currentSavings: currentSavings.trim() === "" ? null : Number(currentSavings),
      });
      await loadStats();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const stats = thisMonth
    ? [
        { label: "Balance", value: rupee.format(thisMonth.balance) },
        { label: "Cumulative", value: rupee.format(thisMonth.cumulative) },
        { label: "Minimum Savings", value: formatOrDash(thisMonth.minimumSavings) },
        { label: "Money Earned", value: rupee.format(thisMonth.moneyEarned) },
        { label: "Money Spent", value: rupee.format(thisMonth.moneySpent) },
        { label: "Current Savings", value: formatOrDash(thisMonth.currentSavings) },
      ]
    : [];

  return (
    <div className="finances">
      <h2>
        {MONTH_NAMES[month - 1]} {year}
      </h2>

      <form className="income-form" onSubmit={handleSave}>
        <div className="field-row">
          <label>
            Salary (₹)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="0.00"
              disabled={loading}
            />
          </label>
          <label>
            Other Income (₹)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={otherIncome}
              onChange={(e) => setOtherIncome(e.target.value)}
              placeholder="Freelance, etc."
              disabled={loading}
            />
          </label>
          <label>
            Current Savings (₹)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={currentSavings}
              onChange={(e) => setCurrentSavings(e.target.value)}
              placeholder="PPF, NPS, APY…"
              disabled={loading}
            />
          </label>
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" className="submit-btn" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      {loading && <p>Loading…</p>}

      {!loading && thisMonth && (
        <div className="finance-stats">
          {stats.map((s) => (
            <div className="finance-stat" key={s.label}>
              <span>{s.label}</span>
              <strong>{s.value}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
