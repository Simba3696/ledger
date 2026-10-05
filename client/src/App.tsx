import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import "./App.css";
import "./shared.css";
import type { Session } from "@supabase/supabase-js";
import {
  ApiError,
  addEntry,
  getCategories,
  getConfig,
  getMonth,
  getMonthLock,
  type CategoryOption,
  type LedgerEntry,
  type ModuleName,
  type UpcomingItem,
} from "./api";
import { MonthYearPicker } from "./components/MonthYearPicker";
import { Dashboard } from "./components/Dashboard";
import { ThemeToggle } from "./components/ThemeToggle";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { MonthLockToggle } from "./components/MonthLockToggle";
import { DialogHost } from "./components/Dialog";
import logoIcon from "./assets/logo-icon.png";
import { useSession } from "./auth/session";
import { AuthLoading, NotAllowed, SignIn } from "./auth/SignIn";
import { SignOutButton } from "./auth/SignOutButton";

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

// Every tab after Dashboard, in nav order, with the module (the server's
// ENABLED_MODULES) that has to be on for it to show. `short` is the label
// below 600px wide (App.css), where the full labels don't fit on one row.
const NAV_TABS: { tab: Exclude<Tab, "dashboard">; module: ModuleName; label: string; short?: string }[] = [
  { tab: "expenses", module: "expenses", label: "Expenses", short: "Spend" },
  { tab: "creditCards", module: "credit-cards", label: "Credit Cards", short: "CC Bills" },
  { tab: "debts", module: "debts", label: "Debts" },
  { tab: "emi", module: "emi", label: "EMI" },
  { tab: "subscriptions", module: "subscriptions", label: "Subscriptions", short: "Subs" },
  { tab: "finances", module: "finances", label: "Finances" },
];

// Where each Upcoming item leads, so an item is never a link to a tab this
// deployment doesn't have (the server already leaves those items out).
const UPCOMING_MODULE: Record<UpcomingItem["source"], ModuleName> = {
  EMI: "emi",
  Subscription: "subscriptions",
  "Credit Card": "credit-cards",
  Salary: "finances",
};

/** Nothing but <SignIn/> until there's a session (LLD §6). The app is keyed
 * on the account, so signing out and back in starts it fresh. */
function App() {
  const auth = useSession();
  if (auth.status === "loading") return <AuthLoading />;
  if (auth.status === "signedOut") return <SignIn notice={auth.notice} />;
  return <Ledger key={auth.session.user.id} session={auth.session} />;
}

function Ledger({ session }: { session: Session }) {
  const now = new Date();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12

  // Null until GET /api/config answers; nothing module-specific renders or
  // fetches before then, so a disabled module's routes are never called.
  const [modules, setModules] = useState<ReadonlySet<ModuleName> | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // The API's 403 for a signed-in account that isn't OWNER_EMAIL. Every
  // route answers it, so the first request (config) is where it shows up.
  const [notAllowed, setNotAllowed] = useState(false);
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

  const expensesOn = modules?.has("expenses") ?? false;

  useEffect(() => {
    getConfig()
      .then((config) => setModules(new Set(config.modules)))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setNotAllowed(true);
        else setConfigError((err as Error).message);
      });
    getCategories().then(setCategories).catch((err) => setLoadError((err as Error).message));
  }, []);

  useEffect(() => {
    if (expensesOn) refresh();
  }, [refresh, expensesOn]);

  useEffect(() => {
    if (expensesOn) refreshLock();
  }, [refreshLock, expensesOn]);

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
    if (!modules?.has(UPCOMING_MODULE[item.source])) return;
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

  if (notAllowed) return <NotAllowed email={session.user.email} />;

  return (
    <div className="app">
      <header>
        <button type="button" className="brand" onClick={() => setTab("dashboard")} aria-label="Go to Dashboard">
          <img src={logoIcon} alt="" className="brand-logo" />
          <h1>Ledger</h1>
        </button>
        <div className="header-right">
          {(tab === "expenses" || tab === "finances" || tab === "creditCards") && (
            <MonthYearPicker month={month} year={year} onMonthChange={setMonth} onYearChange={setYear} />
          )}
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>

      <nav className="tabs">
        <button type="button" className={tab === "dashboard" ? "selected" : ""} onClick={() => setTab("dashboard")}>
          <span className="tab-label-full">Dashboard</span>
          <span className="tab-label-short">Home</span>
        </button>
        {NAV_TABS.filter((t) => modules?.has(t.module)).map((t) => (
          <button key={t.tab} type="button" className={tab === t.tab ? "selected" : ""} onClick={() => setTab(t.tab)}>
            {t.short ? (
              <>
                <span className="tab-label-full">{t.label}</span>
                <span className="tab-label-short">{t.short}</span>
              </>
            ) : (
              t.label
            )}
          </button>
        ))}
      </nav>

      {configError && <p className="error">{configError}</p>}
      {!modules && !configError && <TabFallback />}

      {modules && tab === "dashboard" && (
        <Dashboard
          categories={categories}
          modules={modules}
          onSelectMonth={goToMonth}
          onSelectUpcomingItem={goToUpcomingItem}
        />
      )}
      {tab !== "dashboard" && tab !== "expenses" && (
        <Suspense fallback={<TabFallback />}>
          {tab === "creditCards" && <CreditCards year={year} month={month} />}
          {tab === "debts" && <Debts />}
          {tab === "emi" && <EMI />}
          {tab === "subscriptions" && <Subscriptions />}
          {tab === "finances" && <Finances year={year} month={month} />}
        </Suspense>
      )}
      {/* Reached from its nav tab or a Dashboard chart click (goToMonth). */}
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

      <DialogHost />
    </div>
  );
}

export default App;
