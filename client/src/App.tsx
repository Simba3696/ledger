import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import "./App.css";
import "./shared.css";
import {
  addEntry,
  getCategories,
  getMonth,
  getMonthLock,
  type CategoryOption,
  type LedgerEntry,
  type UpcomingItem,
} from "./api";
import { MonthYearPicker } from "./components/MonthYearPicker";
import { Dashboard } from "./components/Dashboard";
import { ThemeToggle } from "./components/ThemeToggle";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { MonthLockToggle } from "./components/MonthLockToggle";
import logoIcon from "./assets/logo-icon.png";

// Dashboard is the default tab (needed on first paint, so it stays eager);
// everything else here is only ever needed after the user actually clicks
// its tab, so splitting them into their own chunks trims the JS the phone
// has to download/parse before the app is interactive — especially over
// Tailscale, where the connection is often slower than localhost.
const AddExpenseForm = lazy(() => import("./components/AddExpenseForm").then((m) => ({ default: m.AddExpenseForm })));
const RecentEntries = lazy(() => import("./components/RecentEntries").then((m) => ({ default: m.RecentEntries })));
const Finances = lazy(() => import("./components/Finances").then((m) => ({ default: m.Finances })));
const Debts = lazy(() => import("./components/Debts").then((m) => ({ default: m.Debts })));
const CreditCards = lazy(() => import("./components/CreditCards").then((m) => ({ default: m.CreditCards })));
const EMI = lazy(() => import("./components/EMI").then((m) => ({ default: m.EMI })));
const Subscriptions = lazy(() => import("./components/Subscriptions").then((m) => ({ default: m.Subscriptions })));

function TabFallback() {
  return (
    <div className="tab-loading">
      <LoadingOverlay active />
    </div>
  );
}

type Tab = "expenses" | "dashboard" | "finances" | "debts" | "creditCards" | "emi" | "subscriptions";

function App() {
  const now = new Date();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12

  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Nothing auto-locks on the 1st of the month anymore — a month stays
  // editable (default false, i.e. unlocked) until explicitly locked via
  // MonthLockToggle, backed by real server-side enforcement (a locked
  // month's sheet rejects writes regardless of what the UI shows).
  const [locked, setLocked] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getMonth(year, month);
      setEntries(data);
    } catch (err) {
      // Clear stale entries too — otherwise switching to a month/year that
      // fails to load (e.g. a not-yet-created year) leaves the previous
      // month's entries on screen underneath the error message.
      setEntries([]);
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  const refreshLock = useCallback(async () => {
    try {
      const { locked } = await getMonthLock(year, month);
      setLocked(locked);
    } catch {
      // A missing year/workbook (e.g. browsing to a future month before
      // adding anything) has nothing to lock — default to unlocked rather
      // than surfacing this as an error; getMonth's own fetch already
      // reports the real "nothing here yet" state via loadError.
      setLocked(false);
    }
  }, [year, month]);

  useEffect(() => {
    getCategories().then(setCategories).catch((err) => setLoadError((err as Error).message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshLock();
  }, [refreshLock]);

  function goToMonth(y: number, m: number) {
    setYear(y);
    setMonth(m);
    setTab("expenses");
  }

  // Credit Cards and the Salary reminder are month-scoped, so also jump
  // year/month to match the item's actual due date (for Salary, that's
  // last month, per its own dueDate), not whatever's currently selected.
  function goToMonthScoped(dueDate: string, tab: Tab) {
    const [y, m] = dueDate.split("-").map(Number);
    setYear(y);
    setMonth(m);
    setTab(tab);
  }

  // EMI/Subscriptions are flat lists (no month scope) — just switch tabs.
  function goToUpcomingItem(item: UpcomingItem) {
    if (item.source === "EMI") {
      setTab("emi");
    } else if (item.source === "Subscription") {
      setTab("subscriptions");
    } else if (item.source === "Salary") {
      goToMonthScoped(item.dueDate, "finances");
    } else {
      goToMonthScoped(item.dueDate, "creditCards");
    }
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img src={logoIcon} alt="" className="brand-logo" />
          <h1>Ledger</h1>
        </div>
        <div className="header-right">
          {(tab === "expenses" || tab === "finances" || tab === "creditCards") && (
            <MonthYearPicker month={month} year={year} onMonthChange={setMonth} onYearChange={setYear} />
          )}
          <ThemeToggle />
        </div>
      </header>

      <nav className="tabs">
        <button type="button" className={tab === "dashboard" ? "selected" : ""} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        <button
          type="button"
          className={tab === "creditCards" ? "selected" : ""}
          onClick={() => setTab("creditCards")}
        >
          <span className="tab-label-full">Credit Cards</span>
          <span className="tab-label-short">CC Bills</span>
        </button>
        <button type="button" className={tab === "debts" ? "selected" : ""} onClick={() => setTab("debts")}>
          Debts
        </button>
        <button type="button" className={tab === "emi" ? "selected" : ""} onClick={() => setTab("emi")}>
          EMI
        </button>
        <button
          type="button"
          className={tab === "subscriptions" ? "selected" : ""}
          onClick={() => setTab("subscriptions")}
        >
          <span className="tab-label-full">Subscriptions</span>
          <span className="tab-label-short">Subs</span>
        </button>
        <button type="button" className={tab === "finances" ? "selected" : ""} onClick={() => setTab("finances")}>
          Finances
        </button>
      </nav>

      {tab === "dashboard" && <Dashboard onSelectMonth={goToMonth} onSelectUpcomingItem={goToUpcomingItem} />}
      {tab !== "dashboard" && tab !== "expenses" && (
        <Suspense fallback={<TabFallback />}>
          {tab === "creditCards" && <CreditCards year={year} month={month} />}
          {tab === "debts" && <Debts />}
          {tab === "emi" && <EMI />}
          {tab === "subscriptions" && <Subscriptions />}
          {tab === "finances" && <Finances year={year} month={month} />}
        </Suspense>
      )}
      {/* Expenses has no nav button — only reachable via a Dashboard chart click (goToMonth). */}
      {tab === "expenses" && (
        <Suspense fallback={<TabFallback />}>
          <MonthLockToggle
            year={year}
            month={month}
            locked={locked}
            onChanged={async () => {
              await refreshLock();
              await refresh();
            }}
          />
          <AddExpenseForm
            categories={categories}
            disabled={locked}
            onSubmit={async (input) => {
              await addEntry({ year, month, ...input });
              await refresh();
            }}
          />

          {loadError && <p className="error">{loadError}</p>}
          <RecentEntries
            entries={entries}
            categories={categories}
            loading={loading}
            year={year}
            month={month}
            editable={!locked}
            onChanged={refresh}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
