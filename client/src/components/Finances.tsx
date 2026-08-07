import { useCallback, useEffect, useState } from "react";
import { getFinanceSummary, getMonthIncome, setMonthIncome, type MonthFinanceSummary, type SavingsEntry } from "../api";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import { generateId } from "../id";
import "./Finances.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  year: number;
  month: number;
}

interface SavingsRow {
  id: string;
  name: string;
  /** This scheme's balance carried forward from before this month — the
   * value `delta` is added to, not something the user edits directly. 0 for
   * a scheme that doesn't exist yet (a brand new row). */
  baseline: number;
  /** What the user actually types: "+2400" for a deposit, "-500" for a
   * withdrawal. The stored/saved amount is always baseline + delta, so the
   * underlying data model stays a plain absolute balance per scheme — only
   * entry is delta-based. */
  delta: string;
}

function formatOrDash(value: number | null): string {
  return value === null ? "—" : rupee.format(value);
}

/** Builds one row per scheme name known either from last month's carried-
 * forward balances or from this month's own already-saved entry (the union
 * of both, so reopening a month never silently forgets a scheme). For a name
 * present in both, `delta` is back-computed from the saved absolute amount so
 * reopening an already-edited month shows the same change you typed in. */
function toRows(previousSavings: SavingsEntry[], thisMonthSavings: SavingsEntry[]): SavingsRow[] {
  const baselineByName = new Map(previousSavings.map((s) => [s.name, s.amount]));
  const savedByName = new Map(thisMonthSavings.map((s) => [s.name, s.amount]));
  const names = [...new Set([...baselineByName.keys(), ...savedByName.keys()])];
  return names.map((name) => {
    const baseline = baselineByName.get(name) ?? 0;
    const saved = savedByName.get(name) ?? baseline;
    return { id: generateId(), name, baseline, delta: String(saved - baseline) };
  });
}

/** Compares savings rows by their actual field values, ignoring the
 * client-only `id` key — used to tell whether the form has unsaved changes. */
function savingsRowsEqual(a: SavingsRow[], b: SavingsRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.name === b[i].name && row.baseline === b[i].baseline && row.delta === b[i].delta);
}

interface SavingsEditorProps {
  rows: SavingsRow[];
  onChange: (rows: SavingsRow[]) => void;
  disabled: boolean;
}

function SavingsEditor({ rows, onChange, disabled }: SavingsEditorProps) {
  function updateRow(id: string, patch: Partial<SavingsRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }
  function addRow() {
    onChange([...rows, { id: generateId(), name: "", baseline: 0, delta: "" }]);
  }

  const newBalance = (row: SavingsRow) => row.baseline + (Number(row.delta) || 0);
  const total = rows.reduce((sum, r) => sum + newBalance(r), 0);

  return (
    <div className="savings-editor">
      <div className="savings-editor-header">
        <span>Current Savings</span>
        <span className="savings-editor-total">{rupee.format(total)}</span>
      </div>

      {rows.map((row) => (
        <div className="savings-row" key={row.id}>
          <div className="savings-row-main">
            <input
              type="text"
              placeholder="Scheme (PPF, NPS, APY…)"
              value={row.name}
              onChange={(e) => updateRow(row.id, { name: e.target.value })}
              disabled={disabled}
            />
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              placeholder="+/− change"
              value={row.delta}
              onChange={(e) => updateRow(row.id, { delta: e.target.value })}
              disabled={disabled}
            />
            <button
              type="button"
              className="savings-remove"
              onClick={() => removeRow(row.id)}
              disabled={disabled}
              aria-label={`Remove ${row.name || "this scheme"}`}
            >
              ×
            </button>
          </div>
          <div className="savings-row-detail">
            was {rupee.format(row.baseline)}
            {Number(row.delta) !== 0 && <> → <span className="new-balance">{rupee.format(newBalance(row))}</span></>}
          </div>
        </div>
      ))}

      <button type="button" className="savings-add" onClick={addRow} disabled={disabled}>
        + Add scheme
      </button>
    </div>
  );
}

export function Finances({ year, month }: Props) {
  const [salary, setSalary] = useState("");
  const [otherIncome, setOtherIncome] = useState("");
  const [savingsRows, setSavingsRows] = useState<SavingsRow[]>([]);
  // The last loaded-or-saved state, to tell whether Save has anything to do.
  const [savedSalary, setSavedSalary] = useState("");
  const [savedOtherIncome, setSavedOtherIncome] = useState("");
  const [savedSavingsRows, setSavedSavingsRows] = useState<SavingsRow[]>([]);
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
      const salaryValue = income.salary !== null ? String(income.salary) : "";
      const otherIncomeValue = income.otherIncome !== null ? String(income.otherIncome) : "";
      const rows = toRows(income.previousSavings, income.savings);
      setSalary(salaryValue);
      setOtherIncome(otherIncomeValue);
      setSavingsRows(rows);
      setSavedSalary(salaryValue);
      setSavedOtherIncome(otherIncomeValue);
      setSavedSavingsRows(rows);
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
      const savings = savingsRows
        .filter((r) => r.name.trim() !== "")
        .map((r) => ({ name: r.name.trim(), amount: r.baseline + (Number(r.delta) || 0) }));
      await setMonthIncome(year, month, {
        salary: salary.trim() === "" ? null : Number(salary),
        otherIncome: otherIncome.trim() === "" ? null : Number(otherIncome),
        savings,
      });
      await loadStats();
      setSavedSalary(salary);
      setSavedOtherIncome(otherIncome);
      setSavedSavingsRows(savingsRows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const isDirty =
    salary !== savedSalary || otherIncome !== savedOtherIncome || !savingsRowsEqual(savingsRows, savedSavingsRows);

  const stats = thisMonth
    ? [
        { label: "Balance", value: rupee.format(thisMonth.balance), raw: thisMonth.balance },
        { label: "Cumulative", value: rupee.format(thisMonth.cumulative), raw: thisMonth.cumulative },
        { label: "Minimum Savings", value: formatOrDash(thisMonth.minimumSavings), raw: thisMonth.minimumSavings },
        { label: "Money Earned", value: rupee.format(thisMonth.moneyEarned), raw: thisMonth.moneyEarned },
        { label: "Money Spent", value: rupee.format(thisMonth.moneySpent), raw: thisMonth.moneySpent },
        { label: "Current Savings", value: formatOrDash(thisMonth.currentSavings), raw: thisMonth.currentSavings },
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
        </div>

        <SavingsEditor rows={savingsRows} onChange={setSavingsRows} disabled={loading} />

        {error && <p className="error">{error}</p>}

        <button type="submit" className="submit-btn" disabled={saving || !isDirty}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      <div className="finance-stats-wrap">
        <LoadingOverlay active={loading} />

        {thisMonth && (
          <div className="finance-stats">
            {stats.map((s) => (
              <div className="finance-stat" key={s.label}>
                <span>{s.label}</span>
                <strong className={s.raw !== null && s.raw < 0 ? "negative" : undefined}>{s.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
