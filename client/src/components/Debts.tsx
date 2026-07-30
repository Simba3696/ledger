import { useCallback, useEffect, useMemo, useState } from "react";
import { addDebt, deleteDebt, getDebts, type DebtEntry } from "../api";
import { DebtRow } from "./DebtRow";
import { EditDebtRow } from "./EditDebtRow";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./Debts.css";

type SortField = "name" | "amount" | "direction";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: "name", label: "Name" },
  { field: "amount", label: "Amount" },
  { field: "direction", label: "Type" },
];

/** Groups "owed to you" (negative) and "you owe" (positive) apart, then
 * breaks ties by name within each group — a plain amount sort already
 * clusters by sign as a side effect, but "sort by type" is its own explicit
 * request, so it should behave predictably even when amounts don't
 * naturally separate the two groups (e.g. similar magnitudes on both sides). */
function directionRank(amount: number): number {
  return amount > 0 ? 1 : amount < 0 ? -1 : 0;
}

function sortDebts(debts: DebtEntry[], field: SortField, dir: SortDir): DebtEntry[] {
  const sorted = [...debts].sort((a, b) => {
    let cmp = 0;
    if (field === "name") cmp = a.name.localeCompare(b.name);
    else if (field === "amount") cmp = a.amount - b.amount;
    else {
      cmp = directionRank(a.amount) - directionRank(b.amount);
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
    }
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function Debts() {
  const [debts, setDebts] = useState<DebtEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
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

  const sortedDebts = useMemo(() => sortDebts(debts, sortField, sortDir), [debts, sortField, sortDir]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDebts(await getDebts());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const canAdd = name.trim().length > 0 && amount.trim() !== "" && Number.isFinite(Number(amount)) && !adding;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      await addDebt({ name: name.trim(), amount: Number(amount) });
      setName("");
      setAmount("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(row: number) {
    if (!window.confirm("Delete this debt entry?")) return;
    setBusyRow(row);
    setError(null);
    try {
      await deleteDebt(row);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  const youOwe = debts.filter((d) => d.amount > 0).reduce((sum, d) => sum + d.amount, 0);
  const owedToYou = debts.filter((d) => d.amount < 0).reduce((sum, d) => sum - d.amount, 0);
  const net = youOwe - owedToYou;

  return (
    <div className="debts">
      <h2>Debts</h2>

      {debts.length > 0 && (
        <div className="debts-stats">
          <div className="debt-stat">
            <span>You owe</span>
            <strong className="negative">{rupee.format(youOwe)}</strong>
          </div>
          <div className="debt-stat">
            <span>Owed to you</span>
            <strong className="positive">{rupee.format(owedToYou)}</strong>
          </div>
          <div className="debt-stat">
            <span>Net</span>
            {/* Net > 0 means you owe more overall — that's a liability, so it
                reads red here, the opposite of "Owed to you" above. */}
            <strong className={net > 0 ? "negative" : net < 0 ? "positive" : undefined}>{rupee.format(net)}</strong>
          </div>
        </div>
      )}

      <form className="add-debt-form" onSubmit={handleAdd}>
        <div className="field-row">
          <label>
            Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Who?" required />
          </label>
          <label>
            Amount (₹)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="+ you owe, − owed to you"
              required
            />
          </label>
        </div>
        <button type="submit" className="submit-btn" disabled={!canAdd}>
          {adding ? "Adding…" : "Add Debt"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {debts.length > 1 && (
        <div className="debts-sort">
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

      <div className="debts-body">
        <LoadingOverlay active={loading} />

        {!loading && debts.length === 0 && <p className="empty">No debts tracked yet.</p>}

        <ul className="debts-list">
          {sortedDebts.map((debt) =>
            editingRow === debt.row ? (
              <EditDebtRow
                key={debt.row}
                debt={debt}
                onCancel={() => setEditingRow(null)}
                onSaved={async () => {
                  setEditingRow(null);
                  await refresh();
                }}
              />
            ) : (
              <DebtRow
                key={debt.row}
                debt={debt}
                busy={busyRow === debt.row}
                onEdit={() => setEditingRow(debt.row)}
                onDelete={() => handleDelete(debt.row)}
              />
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
