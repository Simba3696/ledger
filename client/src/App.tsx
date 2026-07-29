import { useEffect, useState, useCallback } from "react";
import "./App.css";
import "./shared.css";
import { addEntry, getCategories, getMonth, type CategoryOption, type LedgerEntry } from "./api";
import { AddExpenseForm } from "./components/AddExpenseForm";
import { RecentEntries } from "./components/RecentEntries";
import { MonthYearPicker } from "./components/MonthYearPicker";
import { Dashboard } from "./components/Dashboard";
import { Finances } from "./components/Finances";
import { Debts } from "./components/Debts";
import { CreditCards } from "./components/CreditCards";
import { EMI } from "./components/EMI";
import { Subscriptions } from "./components/Subscriptions";
import { ThemeToggle } from "./components/ThemeToggle";
import logoIcon from "./assets/logo-icon.png";

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

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

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

  useEffect(() => {
    getCategories().then(setCategories).catch((err) => setLoadError((err as Error).message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function goToMonth(y: number, m: number) {
    setYear(y);
    setMonth(m);
    setTab("expenses");
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
          Subscriptions
        </button>
        <button type="button" className={tab === "finances" ? "selected" : ""} onClick={() => setTab("finances")}>
          Finances
        </button>
      </nav>

      {tab === "dashboard" && <Dashboard onSelectMonth={goToMonth} />}
      {tab === "creditCards" && <CreditCards year={year} month={month} />}
      {tab === "debts" && <Debts />}
      {tab === "emi" && <EMI />}
      {tab === "subscriptions" && <Subscriptions />}
      {tab === "finances" && <Finances year={year} month={month} />}
      {/* Expenses has no nav button — only reachable via a Dashboard chart click (goToMonth). */}
      {tab === "expenses" && (
        <>
          <AddExpenseForm
            categories={categories}
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
            editable={isCurrentMonth}
            onChanged={refresh}
          />
        </>
      )}
    </div>
  );
}

export default App;
