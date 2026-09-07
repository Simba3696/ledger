import { useState } from "react";
import { setMonthLock } from "../api";
import "./MonthLockToggle.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  year: number;
  month: number;
  locked: boolean;
  onChanged: () => Promise<void>;
}

/** Explicit, user-controlled per-month lock — replaces the old "only the
 * current calendar month is editable" rule (nothing auto-locks on the 1st of
 * the month anymore). Backed by real Excel sheet protection on the server
 * (see setMonthLocked in ledger.ts), the same mechanism already honored for
 * a sheet manually protected by hand in Excel. */
export function MonthLockToggle({ year, month, locked, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await setMonthLock(year, month, !locked);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`month-lock${locked ? " locked" : ""}`}>
      <span className="month-lock-status">
        {locked
          ? `🔒 ${MONTH_NAMES[month - 1]} ${year} is locked — adding, editing, and reordering entries is disabled.`
          : `🔓 ${MONTH_NAMES[month - 1]} ${year} is unlocked.`}
      </span>
      <button type="button" className="month-lock-toggle" onClick={toggle} disabled={busy}>
        {busy ? "…" : locked ? "Unlock" : "Lock this month"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
