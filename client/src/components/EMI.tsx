import { useCallback, useEffect, useMemo, useState } from "react";
import { addEmi, deleteEmi, getEmis, payEmi, type EmiEntryComputed } from "../api";
import { EmiRow } from "./EmiRow";
import { EditEmiRow } from "./EditEmiRow";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./EMI.css";

type SortField = "name" | "dueDay" | "emiAmount" | "remaining";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: "name", label: "Name" },
  { field: "dueDay", label: "Due Day" },
  { field: "emiAmount", label: "EMI Amount" },
  { field: "remaining", label: "Remaining" },
];

function sortEmis(emis: EmiEntryComputed[], field: SortField, dir: SortDir): EmiEntryComputed[] {
  const sorted = [...emis].sort((a, b) => {
    let cmp = 0;
    if (field === "name") cmp = a.cardOrBank.localeCompare(b.cardOrBank);
    else if (field === "dueDay") cmp = a.dueDay - b.dueDay;
    else if (field === "emiAmount") cmp = a.emiAmount - b.emiAmount;
    else cmp = a.remaining - b.remaining;
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function EMI() {
  const [emis, setEmis] = useState<EmiEntryComputed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);

  const [cardOrBank, setCardOrBank] = useState("");
  const [emiAmount, setEmiAmount] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [remarks, setRemarks] = useState("");
  const [remainingAsOf, setRemainingAsOf] = useState("");
  const [durationMonths, setDurationMonths] = useState("");
  const [adding, setAdding] = useState(false);

  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function toggleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sortedEmis = useMemo(() => sortEmis(emis, sortField, sortDir), [emis, sortField, sortDir]);

  // A brand-new EMI hasn't had any payments yet, so Current Balance starts
  // out equal to Total Amount — only auto-filled while Current Balance is
  // still blank, so it never clobbers a value you've typed yourself (e.g.
  // when backfilling a loan that's already partway through).
  function handleTotalAmountChange(value: string) {
    setTotalAmount(value);
    if (remainingAsOf.trim() === "") setRemainingAsOf(value);
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEmis(await getEmis());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const dueDayNum = Number(dueDay);
  const canAdd =
    cardOrBank.trim().length > 0 &&
    Number.isFinite(Number(emiAmount)) &&
    Number(emiAmount) > 0 &&
    Number.isInteger(dueDayNum) &&
    dueDayNum >= 1 &&
    dueDayNum <= 31 &&
    Number.isFinite(Number(totalAmount)) &&
    Number.isFinite(Number(remainingAsOf)) &&
    !adding;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      await addEmi({
        cardOrBank: cardOrBank.trim(),
        emiAmount: Number(emiAmount),
        dueDay: dueDayNum,
        totalAmount: Number(totalAmount),
        remarks: remarks.trim(),
        remainingAsOf: Number(remainingAsOf),
        durationMonths: durationMonths.trim() === "" ? null : Number(durationMonths),
      });
      setCardOrBank("");
      setEmiAmount("");
      setDueDay("");
      setTotalAmount("");
      setRemarks("");
      setRemainingAsOf("");
      setDurationMonths("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(row: number) {
    if (!window.confirm("Delete this EMI?")) return;
    setBusyRow(row);
    setError(null);
    try {
      await deleteEmi(row);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  async function handleForeclose(emi: EmiEntryComputed) {
    // Matches the user's actual real-world workflow: once a loan is fully
    // paid off (whether by reaching ₹0 naturally or being paid off early),
    // it comes off the list entirely rather than lingering as "Paid off" —
    // same underlying delete as the general Delete action, just the
    // dedicated, clearly-labeled entry point for that specific moment.
    if (!window.confirm(`Foreclose ${emi.cardOrBank}? This removes it from your EMI list.`)) return;
    setBusyRow(emi.row);
    setError(null);
    try {
      await deleteEmi(emi.row);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  async function handlePay(row: number, amount: number) {
    setBusyRow(row);
    setError(null);
    try {
      await payEmi(row, amount);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  function handlePaidThisMonth(emi: EmiEntryComputed) {
    handlePay(emi.row, emi.emiAmount);
  }

  function handleRecordPayment(emi: EmiEntryComputed) {
    const input = window.prompt(`How much did you pay toward ${emi.cardOrBank}?`, String(emi.emiAmount));
    // Treat both an explicit Cancel (null) and a blank submission the same
    // way — a blank prompt isn't a deliberate "I paid ₹0", and Number("")
    // is 0, so without this check it would silently look like a valid
    // zero-amount payment instead of a no-op.
    if (input === null || input.trim() === "") return;
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Payment amount must be a non-negative number");
      return;
    }
    handlePay(emi.row, amount);
  }

  const active = emis.filter((e) => !e.isPaidOff);
  const totalRemaining = emis.reduce((sum, e) => sum + e.remaining, 0);
  const totalMonthly = active.reduce((sum, e) => sum + e.emiAmount, 0);

  return (
    <div className="emi">
      <h2>EMI</h2>

      {emis.length > 0 && (
        <div className="emi-stats">
          <div className="emi-stat">
            <span>Total Remaining</span>
            <strong>{rupee.format(totalRemaining)}</strong>
          </div>
          <div className="emi-stat">
            <span>Total Monthly EMI</span>
            <strong>{rupee.format(totalMonthly)}</strong>
          </div>
          <div className="emi-stat">
            <span>Active Loans</span>
            <strong>{active.length}</strong>
          </div>
        </div>
      )}

      <form className="add-emi-form" onSubmit={handleAdd}>
        <div className="field-row">
          <label>
            Card / Bank
            <input type="text" value={cardOrBank} onChange={(e) => setCardOrBank(e.target.value)} placeholder="Who's it with?" required />
          </label>
          <label>
            EMI Amount (₹/mo)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={emiAmount}
              onChange={(e) => setEmiAmount(e.target.value)}
              required
            />
          </label>
          <label>
            Due Day
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              placeholder="1-31"
              required
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            Total Amount (₹)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={totalAmount}
              onChange={(e) => handleTotalAmountChange(e.target.value)}
              required
            />
          </label>
          <label>
            Current Balance (₹)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={remainingAsOf}
              onChange={(e) => setRemainingAsOf(e.target.value)}
              placeholder="Defaults to Total Amount"
              required
            />
          </label>
          <label>
            Duration (months) — optional
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={durationMonths}
              onChange={(e) => setDurationMonths(e.target.value)}
              placeholder="If the bank told you"
            />
          </label>
          <label>
            Remarks
            <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" />
          </label>
        </div>
        <button type="submit" className="submit-btn" disabled={!canAdd}>
          {adding ? "Adding…" : "Add EMI"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {emis.length > 1 && (
        <div className="emi-sort">
          <span>Sort by</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.field}
              className={sortField === opt.field ? "selected" : ""}
              onClick={() => toggleSort(opt.field)}
            >
              {opt.label}
              {sortField === opt.field && <span className="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="emi-body">
        <LoadingOverlay active={loading} />

        {!loading && emis.length === 0 && <p className="empty">No EMIs tracked yet.</p>}

        <ul className="emi-list">
          {sortedEmis.map((emi) =>
            editingRow === emi.row ? (
              <EditEmiRow
                key={emi.row}
                emi={emi}
                onCancel={() => setEditingRow(null)}
                onSaved={async () => {
                  setEditingRow(null);
                  await refresh();
                }}
              />
            ) : (
              <EmiRow
                key={emi.row}
                emi={emi}
                busy={busyRow === emi.row}
                onEdit={() => setEditingRow(emi.row)}
                onDelete={() => handleDelete(emi.row)}
                onPaidThisMonth={() => handlePaidThisMonth(emi)}
                onRecordPayment={() => handleRecordPayment(emi)}
                onForeclose={() => handleForeclose(emi)}
              />
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
