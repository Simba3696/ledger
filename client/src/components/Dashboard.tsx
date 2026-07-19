import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  type MouseHandlerDataParam,
} from "recharts";
import { getYearSummary, type MonthSummary } from "../api";
import { CATEGORY_SWATCH } from "../categoryColors";
import { YearSelect } from "./YearSelect";
import "./Dashboard.css";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

interface Props {
  onSelectMonth: (year: number, month: number) => void;
}

export function Dashboard({ onSelectMonth }: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<MonthSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getYearSummary(year)
      .then(setData)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [year]);

  const chartData = data.map((m) => ({
    name: MONTH_ABBR[m.month - 1],
    month: m.month,
    Food: m.food,
    Transportation: m.transportation,
    Rent: m.rent,
    Other: m.other,
  }));

  const yearTotal = data.reduce((sum, m) => sum + m.total, 0);

  function handleBarClick(state: MouseHandlerDataParam) {
    if (state.activeTooltipIndex == null) return;
    const index = Number(state.activeTooltipIndex);
    if (Number.isNaN(index)) return;
    const row = chartData[index];
    if (row) onSelectMonth(year, row.month);
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Yearly Overview</h2>
        <YearSelect value={year} onChange={setYear} />
      </div>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && !error && (
        <>
          <div className="dashboard-total">
            <span>Total for {year}</span>
            <strong>{rupee.format(yearTotal)}</strong>
          </div>

          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={chartData} onClick={handleBarClick}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" stroke="var(--text)" fontSize={12} />
                <YAxis stroke="var(--text)" fontSize={12} />
                <Tooltip
                  formatter={(value) => rupee.format(Number(value))}
                  contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8 }}
                />
                <Legend />
                <Bar dataKey="Food" stackId="category" fill={CATEGORY_SWATCH.food.bg} className="dashboard-bar" />
                <Bar
                  dataKey="Transportation"
                  stackId="category"
                  fill={CATEGORY_SWATCH.transportation.bg}
                  className="dashboard-bar"
                />
                <Bar dataKey="Rent" stackId="category" fill={CATEGORY_SWATCH.rent.bg} className="dashboard-bar" />
                <Bar
                  dataKey="Other"
                  stackId="category"
                  fill={CATEGORY_SWATCH.other.bg}
                  radius={[4, 4, 0, 0]}
                  className="dashboard-bar"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="dashboard-hint">Click a month to view or add entries for it.</p>
        </>
      )}
    </div>
  );
}
