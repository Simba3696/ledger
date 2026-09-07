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
import { getYearSummary, type CategoryOption, type MonthSummary, type UpcomingItem } from "../api";
import { YearSelect } from "./YearSelect";
import { LoadingOverlay } from "./LoadingOverlay";
import { DashboardOverview } from "./DashboardOverview";
import { EmiProjectionChart } from "./EmiProjectionChart";
import { rupee } from "../format";
import "./Dashboard.css";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Keyed by category label (not id) since that's what's shown in the chart's
// tooltip/legend — assumes labels are unique, same assumption the picker/
// entry-list swatches already make.
interface ChartRow {
  name: string;
  month: number;
  [categoryLabel: string]: number | string;
}

// Shared across every BarChart below so hovering a month in any one of them
// (main or per-category) highlights the same month's cursor/tooltip in all
// the others — they all plot the same chartData in the same month order, so
// Recharts' default index-based sync lines them up correctly.
const DASHBOARD_SYNC_ID = "dashboard-charts";

/** One category's monthly totals in isolation — each auto-scales to its own
 * range (rather than sharing the main chart's combined scale), so a lower-
 * spend category's month-to-month pattern is still readable instead of
 * looking flat next to a much bigger one. Clickable the same way as the main
 * chart (same onBarClick, same index-based month lookup, since every chart
 * plots the identical chartData array). Module-level, not nested inside
 * Dashboard, so it isn't redefined (and its subtree remounted) every render. */
function CategoryMiniChart({
  data,
  dataKey,
  color,
  onBarClick,
}: {
  data: ChartRow[];
  dataKey: string;
  color: string;
  onBarClick: (state: MouseHandlerDataParam) => void;
}) {
  return (
    <div className="category-chart">
      <h3>{dataKey}</h3>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} syncId={DASHBOARD_SYNC_ID} onClick={onBarClick} className="clickable-chart">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" stroke="var(--text)" fontSize={11} />
          <YAxis stroke="var(--text)" fontSize={11} width={40} />
          <Tooltip
            formatter={(value) => rupee.format(Number(value))}
            contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8 }}
          />
          <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface Props {
  categories: CategoryOption[];
  onSelectMonth: (year: number, month: number) => void;
  onSelectUpcomingItem: (item: UpcomingItem) => void;
}

export function Dashboard({ categories, onSelectMonth, onSelectUpcomingItem }: Props) {
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

  const chartData: ChartRow[] = data.map((m) => ({
    name: MONTH_ABBR[m.month - 1],
    month: m.month,
    ...Object.fromEntries(categories.map((c) => [c.label, m.categoryTotals[c.id] ?? 0])),
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
      <DashboardOverview onSelectUpcomingItem={onSelectUpcomingItem} />

      <EmiProjectionChart />

      <div className="dashboard-header">
        <h2>Yearly Overview</h2>
        <YearSelect value={year} onChange={setYear} />
      </div>

      {error && <p className="error">{error}</p>}

      {!error && (
        <div className="dashboard-body">
          <LoadingOverlay active={loading} />

          <div className="dashboard-total">
            <span>Total for {year}</span>
            <strong>{rupee.format(yearTotal)}</strong>
          </div>

          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={chartData} onClick={handleBarClick} syncId={DASHBOARD_SYNC_ID} className="clickable-chart">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" stroke="var(--text)" fontSize={12} />
                <YAxis stroke="var(--text)" fontSize={12} />
                <Tooltip
                  formatter={(value) => rupee.format(Number(value))}
                  contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8 }}
                />
                <Legend />
                {categories.map((c, i) => (
                  <Bar
                    key={c.id}
                    dataKey={c.label}
                    stackId="category"
                    fill={c.bg}
                    radius={i === categories.length - 1 ? [4, 4, 0, 0] : undefined}
                    className="dashboard-bar"
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="dashboard-hint">Click a month to view or add entries for it.</p>

          <div className="category-charts">
            {categories.map((c) => (
              <CategoryMiniChart key={c.id} data={chartData} dataKey={c.label} color={c.bg} onBarClick={handleBarClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
