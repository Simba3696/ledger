import { useCallback, useEffect, useState } from "react";
import { addEmi, deleteEmi, getEmis, type EmiEntryComputed } from "../api";
import { EmiRow } from "./EmiRow";
import { EditEmiRow } from "./EditEmiRow";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./EMI.css";

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
  const [adding, setAdding] = useState(false);

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
      });
      setCardOrBank("");
      setEmiAmount("");
      setDueDay("");
      setTotalAmount("");
      setRemarks("");
      setRemainingAsOf("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(row: number) {
    if (!window.confirm("Delete this EMI? Use this once a loan is fully paid off or foreclosed.")) return;
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
              onChange={(e) => setTotalAmount(e.target.value)}
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
              placeholder="What's left today"
              required
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

      <div className="emi-body">
        <LoadingOverlay active={loading} />

        {!loading && emis.length === 0 && <p className="empty">No EMIs tracked yet.</p>}

        <ul className="emi-list">
          {emis.map((emi) =>
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
              />
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
