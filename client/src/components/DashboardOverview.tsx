import { useEffect, useState } from "react";
import { getOverview, type DashboardOverview as DashboardOverviewData, type UpcomingItem } from "../api";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./DashboardOverview.css";

const SOURCE_LABEL: Record<UpcomingItem["source"], string> = {
  EMI: "EMI",
  Subscription: "Sub",
  "Credit Card": "Card",
};

const UPCOMING_COLLAPSED_KEY = "ledger-upcoming-collapsed";

function getInitialCollapsed(): boolean {
  // Defaults open — Upcoming is the actionable part of the dashboard, so
  // folding it away by default would hide the thing most worth seeing.
  // Only stays collapsed if the user explicitly closed it last time.
  return localStorage.getItem(UPCOMING_COLLAPSED_KEY) === "true";
}

function formatDueDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

interface Props {
  onSelectUpcomingItem: (item: UpcomingItem) => void;
}

export function DashboardOverview({ onSelectUpcomingItem }: Props) {
  const [data, setData] = useState<DashboardOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(getInitialCollapsed);

  useEffect(() => {
    localStorage.setItem(UPCOMING_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getOverview()
      .then(setData)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <p className="error">{error}</p>;

  const netWorth = data?.netWorth;
  const upcoming = data?.upcoming ?? [];
  const upcomingTotal = upcoming.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="overview-panel">
      <div className="overview-body">
        <LoadingOverlay active={loading} />

        {netWorth && (
          <div className="overview-stats">
            <div className="overview-stat overview-stat-headline">
              <span>Net Worth</span>
              <strong className={netWorth.netWorth < 0 ? "negative" : "positive"}>
                {rupee.format(netWorth.netWorth)}
              </strong>
            </div>
            <div className="overview-stat">
              <span>Current Savings</span>
              <strong>{rupee.format(netWorth.currentSavings)}</strong>
            </div>
            <div className="overview-stat">
              <span>Total Debt</span>
              <strong>{rupee.format(netWorth.totalDebt)}</strong>
            </div>
            <div className="overview-stat">
              <span>EMI Remaining</span>
              <strong>{rupee.format(netWorth.emiRemaining)}</strong>
            </div>
            <div className="overview-stat">
              <span>Credit Cards Owed (This Month)</span>
              <strong>{rupee.format(netWorth.creditCardOutstanding)}</strong>
            </div>
          </div>
        )}

        <div className="upcoming">
          <button
            type="button"
            className="upcoming-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            <span className={`upcoming-chevron${collapsed ? " collapsed" : ""}`} aria-hidden="true">
              ▾
            </span>
            <h3>
              <span className="upcoming-title-full">Upcoming (next 2 weeks)</span>
              <span className="upcoming-title-short">Upcoming</span>
            </h3>
            {upcoming.length > 0 && <span className="upcoming-total">{rupee.format(upcomingTotal)}</span>}
          </button>
          {/* Content stays in the DOM either way — the grid-rows/0fr trick
              below animates the fold smoothly, which conditionally rendering
              the content (mount/unmount) can't do. */}
          <div className={`upcoming-collapse${collapsed ? " collapsed" : ""}`}>
            <div className="upcoming-collapse-inner">
              {data && upcoming.length === 0 && <p className="empty">Nothing due in the next 2 weeks.</p>}
              {upcoming.length > 0 && (
                <ul className="upcoming-list">
                  {upcoming.map((item, i) => (
                    <li key={`${item.source}-${item.name}-${item.dueDate}-${i}`}>
                      <button
                        type="button"
                        className="upcoming-item"
                        onClick={() => onSelectUpcomingItem(item)}
                        title={`Go to ${item.source === "EMI" ? "EMI" : item.source === "Subscription" ? "Subscriptions" : "Credit Cards"}`}
                      >
                        <span className="upcoming-source">{SOURCE_LABEL[item.source]}</span>
                        <span className="upcoming-name">{item.name}</span>
                        <span className="upcoming-date">{formatDueDate(item.dueDate)}</span>
                        <span className="upcoming-amount">{rupee.format(item.amount)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
