import { useEffect, useState, useCallback } from "react";
import "./App.css";
import "./shared.css";
import { addEntry, getCategories, getMonth, type CategoryOption, type LedgerEntry } from "./api";
import { AddExpenseForm } from "./components/AddExpenseForm";
import { RecentEntries } from "./components/RecentEntries";
import { MonthYearPicker } from "./components/MonthYearPicker";
import { Dashboard } from "./components/Dashboard";
import { ThemeToggle } from "./components/ThemeToggle";
import logoIcon from "./assets/logo-icon.png";

type Tab = "ledger" | "dashboard";

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
    setTab("ledger");
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img src={logoIcon} alt="" className="brand-logo" />
          <h1>Ledger</h1>
        </div>
        <div className="header-right">
          {tab === "ledger" && (
            <MonthYearPicker month={month} year={year} onMonthChange={setMonth} onYearChange={setYear} />
          )}
          <ThemeToggle />
        </div>
      </header>

      <nav className="tabs">
        <button type="button" className={tab === "ledger" ? "selected" : ""} onClick={() => setTab("ledger")}>
          Ledger
        </button>
        <button type="button" className={tab === "dashboard" ? "selected" : ""} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
      </nav>

      {tab === "ledger" ? (
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
      ) : (
        <Dashboard onSelectMonth={goToMonth} />
      )}
    </div>
  );
}

export default App;
