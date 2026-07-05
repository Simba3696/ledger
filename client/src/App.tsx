import { useEffect, useState, useCallback } from "react";
import "./App.css";
import { addEntry, getCategories, getMonth, type CategoryOption, type LedgerEntry } from "./api";
import { AddExpenseForm } from "./components/AddExpenseForm";
import { RecentEntries } from "./components/RecentEntries";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const EARLIEST_YEAR = 2018;

function App() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12

  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const years = Array.from({ length: now.getFullYear() - EARLIEST_YEAR + 1 }, (_, i) => EARLIEST_YEAR + i);

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

  return (
    <div className="app">
      <header>
        <h1>Ledger</h1>
        <div className="month-picker">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((name, idx) => (
              <option key={name} value={idx + 1}>{name}</option>
            ))}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </header>

      <AddExpenseForm
        categories={categories}
        year={year}
        month={month}
        onSubmit={async (input) => {
          await addEntry({ year, month, ...input });
          await refresh();
        }}
      />

      {loadError && <p className="error">{loadError}</p>}
      <RecentEntries entries={entries} categories={categories} loading={loading} />
    </div>
  );
}

export default App;
