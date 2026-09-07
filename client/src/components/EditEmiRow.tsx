import { useState } from "react";
import { updateEmi, type EmiEntryComputed } from "../api";

interface Props {
  emi: EmiEntryComputed;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function EditEmiRow({ emi, onCancel, onSaved }: Props) {
  const [cardOrBank, setCardOrBank] = useState(emi.cardOrBank);
  const [emiAmount, setEmiAmount] = useState(String(emi.emiAmount));
  const [dueDay, setDueDay] = useState(String(emi.dueDay));
  const [totalAmount, setTotalAmount] = useState(String(emi.totalAmount));
  const [remarks, setRemarks] = useState(emi.remarks);
  const [remainingAsOf, setRemainingAsOf] = useState(String(emi.remaining));
  const [durationMonths, setDurationMonths] = useState("");
  const [interestRate, setInterestRate] = useState(emi.interestRate === null ? "" : String(emi.interestRate));
  const [foreclosureCharge, setForeclosureCharge] = useState(
    emi.foreclosureCharge === null ? "" : String(emi.foreclosureCharge),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dueDayNum = Number(dueDay);
  const canSave =
    cardOrBank.trim().length > 0 &&
    Number.isFinite(Number(emiAmount)) &&
    Number(emiAmount) > 0 &&
    Number.isInteger(dueDayNum) &&
    dueDayNum >= 1 &&
    dueDayNum <= 31 &&
    Number.isFinite(Number(totalAmount)) &&
    Number.isFinite(Number(remainingAsOf)) &&
    !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateEmi(emi.row, {
        cardOrBank: cardOrBank.trim(),
        emiAmount: Number(emiAmount),
        dueDay: dueDayNum,
        totalAmount: Number(totalAmount),
        remarks: remarks.trim(),
        remainingAsOf: Number(remainingAsOf),
        durationMonths: durationMonths.trim() === "" ? null : Number(durationMonths),
        interestRate: interestRate.trim() === "" ? null : Number(interestRate),
        foreclosureCharge: foreclosureCharge.trim() === "" ? null : Number(foreclosureCharge),
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <li className="emi-row row-editing">
      <div className="edit-fields emi-edit-fields">
        <input type="text" value={cardOrBank} onChange={(e) => setCardOrBank(e.target.value)} placeholder="Card / Bank" />
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          value={emiAmount}
          onChange={(e) => setEmiAmount(e.target.value)}
          placeholder="EMI Amount"
        />
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={31}
          value={dueDay}
          onChange={(e) => setDueDay(e.target.value)}
          placeholder="Due Day"
        />
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          value={totalAmount}
          onChange={(e) => setTotalAmount(e.target.value)}
          placeholder="Total Amount"
        />
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          value={remainingAsOf}
          onChange={(e) => setRemainingAsOf(e.target.value)}
          placeholder="Current Balance"
        />
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={durationMonths}
          onChange={(e) => setDurationMonths(e.target.value)}
          placeholder="Duration (months, optional)"
        />
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          max={100}
          value={interestRate}
          onChange={(e) => setInterestRate(e.target.value)}
          placeholder="Interest Rate (% p.a., optional)"
        />
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          max={100}
          value={foreclosureCharge}
          onChange={(e) => setForeclosureCharge(e.target.value)}
          placeholder="Foreclosure Charge (%, optional)"
        />
        <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Remarks" />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="edit-actions">
        <button type="button" className="submit-btn" onClick={handleSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </li>
  );
}
