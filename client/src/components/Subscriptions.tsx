import { useCallback, useEffect, useMemo, useState } from "react";
import { addSubscription, deleteSubscription, getSubscriptions, type SubscriptionDuration, type SubscriptionEntryComputed } from "../api";
import { SubscriptionRow } from "./SubscriptionRow";
import { EditSubscriptionRow } from "./EditSubscriptionRow";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./Subscriptions.css";

type SortField = "nextExpiry" | "service" | "amount";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: "nextExpiry", label: "Next Renewal" },
  { field: "service", label: "Service" },
  { field: "amount", label: "Amount" },
];

function sortSubscriptions(
  subscriptions: SubscriptionEntryComputed[],
  field: SortField,
  dir: SortDir,
): SubscriptionEntryComputed[] {
  const sorted = [...subscriptions].sort((a, b) => {
    let cmp = 0;
    if (field === "nextExpiry") cmp = a.nextExpiry.localeCompare(b.nextExpiry);
    else if (field === "service") cmp = a.service.localeCompare(b.service);
    else cmp = a.amount - b.amount;
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function Subscriptions() {
  const [subscriptions, setSubscriptions] = useState<SubscriptionEntryComputed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);

  const [service, setService] = useState("");
  const [amount, setAmount] = useState("");
  const [duration, setDuration] = useState<SubscriptionDuration>("Monthly");
  const [expiryAnchor, setExpiryAnchor] = useState("");
  const [cardOrBank, setCardOrBank] = useState("");
  const [adding, setAdding] = useState(false);

  // Defaults to soonest-renewal-first — the whole point of tracking these is
  // knowing what's coming up next, so that should be the view you land on,
  // not one more click away behind an alphabetical default.
  const [sortField, setSortField] = useState<SortField>("nextExpiry");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function toggleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sortedSubscriptions = useMemo(
    () => sortSubscriptions(subscriptions, sortField, sortDir),
    [subscriptions, sortField, sortDir],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSubscriptions(await getSubscriptions());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const canAdd = service.trim().length > 0 && Number.isFinite(Number(amount)) && Number(amount) > 0 && expiryAnchor.trim() !== "" && !adding;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      await addSubscription({
        service: service.trim(),
        amount: Number(amount),
        duration,
        expiryAnchor,
        cardOrBank: cardOrBank.trim(),
      });
      setService("");
      setAmount("");
      setDuration("Monthly");
      setExpiryAnchor("");
      setCardOrBank("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(row: number) {
    if (!window.confirm("Delete this subscription?")) return;
    setBusyRow(row);
    setError(null);
    try {
      await deleteSubscription(row);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  const monthlyEquivalent = subscriptions.reduce(
    (sum, s) => sum + (s.duration === "Monthly" ? s.amount : s.amount / 12),
    0,
  );

  return (
    <div className="subscriptions">
      <h2>Subscriptions</h2>

      {subscriptions.length > 0 && (
        <div className="subscriptions-stats">
          <div className="subscription-stat">
            <span>Monthly Cost (approx)</span>
            <strong>{rupee.format(monthlyEquivalent)}</strong>
          </div>
          <div className="subscription-stat">
            <span>Active Subscriptions</span>
            <strong>{subscriptions.length}</strong>
          </div>
        </div>
      )}

      <form className="add-subscription-form" onSubmit={handleAdd}>
        <div className="field-row">
          <label>
            Service
            <input type="text" value={service} onChange={(e) => setService(e.target.value)} placeholder="Netflix" required />
          </label>
          <label>
            Amount (₹)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </label>
          <label>
            Duration
            <select
              className="select"
              value={duration}
              onChange={(e) => setDuration(e.target.value as SubscriptionDuration)}
            >
              <option value="Monthly">Monthly</option>
              <option value="Yearly">Yearly</option>
            </select>
          </label>
        </div>
        <div className="field-row">
          <label>
            Next Renewal
            <input type="date" value={expiryAnchor} onChange={(e) => setExpiryAnchor(e.target.value)} required />
          </label>
          <label>
            Card / Bank
            <input
              type="text"
              value={cardOrBank}
              onChange={(e) => setCardOrBank(e.target.value)}
              placeholder="Or leave blank for N/A"
            />
          </label>
        </div>
        <button type="submit" className="submit-btn" disabled={!canAdd}>
          {adding ? "Adding…" : "Add Subscription"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {subscriptions.length > 1 && (
        <div className="subscriptions-sort">
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

      <div className="subscriptions-body">
        <LoadingOverlay active={loading} />

        {!loading && subscriptions.length === 0 && <p className="empty">No subscriptions tracked yet.</p>}

        <ul className="subscriptions-list">
          {sortedSubscriptions.map((s) =>
            editingRow === s.row ? (
              <EditSubscriptionRow
                key={s.row}
                subscription={s}
                onCancel={() => setEditingRow(null)}
                onSaved={async () => {
                  setEditingRow(null);
                  await refresh();
                }}
              />
            ) : (
              <SubscriptionRow
                key={s.row}
                subscription={s}
                busy={busyRow === s.row}
                onEdit={() => setEditingRow(s.row)}
                onDelete={() => handleDelete(s.row)}
              />
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
