import { useEffect, useState } from "react";
import { getOverview, type DashboardOverview as DashboardOverviewData, type ModuleName, type UpcomingItem } from "../api";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./DashboardOverview.css";

const SOURCE_LABEL: Record<UpcomingItem["source"], string> = {
  EMI: "EMI",
  Subscription: "Sub",
  "Credit Card": "Card",
  Salary: "Salary",
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

// Same format as the EMI tab's own "EMI-Free On" stat — no weekday, this one
// is a distant milestone date rather than a this-week due date.
function formatEmiFreeDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// The modules that can put an item in Upcoming. Without any of them (e.g.
// only Debts is on alongside Expenses) the section would always be empty.
const UPCOMING_MODULES: ModuleName[] = ["finances", "emi", "credit-cards", "subscriptions"];

/** One stat card; a figure the server sent as null (its module is disabled)
 * renders nothing. */
function Stat({ label, value, className }: { label: string; value: number | null; className?: string }) {
  if (value === null) return null;
  return (
    <div className={`overview-stat${className ? ` ${className}` : ""}`}>
      <span>{label}</span>
      <strong>{rupee.format(value)}</strong>
    </div>
  );
}

interface Props {
  modules: ReadonlySet<ModuleName>;
  onSelectUpcomingItem: (item: UpcomingItem) => void;
}

export function DashboardOverview({ modules, onSelectUpcomingItem }: Props) {
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
  // With only some modules enabled every figure can be null; skip the grid
  // then rather than leave an empty box (and its margin) above Upcoming.
  const hasStats =
    !!data?.emiFreeDate || (!!netWorth && Object.values(netWorth).some((v) => v !== null));
  const upcoming = data?.upcoming ?? [];
  const upcomingTotal = upcoming.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="overview-panel">
      <div className="overview-body">
        <LoadingOverlay active={loading} />

        {netWorth && hasStats && (
          <div className="overview-stats">
            {netWorth.netWorth !== null && (
              <div className="overview-stat overview-stat-headline">
                <span>Net Worth</span>
                <strong className={netWorth.netWorth < 0 ? "negative" : "positive"}>
                  {rupee.format(netWorth.netWorth)}
                </strong>
              </div>
            )}
            <Stat label="Current Savings" value={netWorth.currentSavings} />
            <Stat label="Total Debt" value={netWorth.totalDebt} />
            <Stat label="EMI Remaining" value={netWorth.emiRemaining} />
            <Stat label="Credit Cards Owed (This Month)" value={netWorth.creditCardOutstanding} />
            {data?.emiFreeDate && (
              <div className="overview-stat">
                <span>EMI-Free On</span>
                <strong>{formatEmiFreeDate(data.emiFreeDate)}</strong>
              </div>
            )}
          </div>
        )}

        {UPCOMING_MODULES.some((m) => modules.has(m)) && (
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
                          title={`Go to ${
                            item.source === "EMI"
                              ? "EMI"
                              : item.source === "Subscription"
                                ? "Subscriptions"
                                : item.source === "Salary"
                                  ? "Finances"
                                  : "Credit Cards"
                          }`}
                        >
                          <span className="upcoming-source">{SOURCE_LABEL[item.source]}</span>
                          <span className="upcoming-name">{item.name}</span>
                          {item.source === "Salary" ? (
                            <>
                              <span className="upcoming-date">Overdue</span>
                              <span className="upcoming-amount">Not logged yet</span>
                            </>
                          ) : (
                            <>
                              <span className="upcoming-date">{formatDueDate(item.dueDate)}</span>
                              <span className="upcoming-amount">{rupee.format(item.amount)}</span>
                            </>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
