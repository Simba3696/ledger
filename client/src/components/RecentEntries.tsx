import type { LedgerEntry, CategoryOption } from "../api";
import { CATEGORY_SWATCH } from "../categoryColors";

interface Props {
  entries: LedgerEntry[];
  categories: CategoryOption[];
  loading: boolean;
}

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

export function RecentEntries({ entries, categories, loading }: Props) {
  const labelFor = (id: LedgerEntry["category"]) =>
    categories.find((c) => c.id === id)?.label ?? "Uncategorized";

  const total = entries.reduce((sum, e) => sum + e.amount, 0);

  return (
    <div className="recent-entries">
      <div className="recent-header">
        <h2>Entries this month</h2>
        <span className="total">{rupee.format(total)}</span>
      </div>

      {loading && <p>Loading…</p>}
      {!loading && entries.length === 0 && <p className="empty">No entries yet.</p>}

      <ul>
        {[...entries].reverse().map((entry) => {
          const swatch = entry.category ? CATEGORY_SWATCH[entry.category] : null;
          return (
            <li key={entry.row} className="entry-row">
              <span
                className="entry-category"
                style={swatch ? { background: swatch.bg, color: swatch.fg } : undefined}
              >
                {labelFor(entry.category)}
              </span>
              <span className="entry-remarks">{entry.remarks}</span>
              {entry.isCard && <span className="entry-cc">CC</span>}
              <span className="entry-amount">{rupee.format(entry.amount)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
