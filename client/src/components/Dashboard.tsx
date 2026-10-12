import { useEffect, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  type MouseHandlerDataParam,
} from "recharts";
import { getYearSummary, type CategoryOption, type ModuleName, type MonthSummary, type UpcomingItem } from "../api";
import { EARLIEST_YEAR } from "../constants";
import { AVERAGE_WINDOWS, knownMonths, trailingAverages, type AverageWindow } from "../movingAverage";
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
// The trailing averages ride along under averageKey(...) keys, built from the
// category id rather than its label so a category named, say, "Total" can't
// collide with the month total's average. Null where there isn't a full
// window of data.
interface ChartRow {
  name: string;
  month: number;
  [categoryLabel: string]: number | string | null;
}

const TOTAL_AVERAGE_KEY = "average:total";
const averageKey = (categoryId: string) => `average:category:${categoryId}`;

const AVERAGE_WINDOW_KEY = "ledger-dashboard-average-window";

function getInitialAverageWindow(): AverageWindow {
  const n = Number(localStorage.getItem(AVERAGE_WINDOW_KEY));
  return AVERAGE_WINDOWS.find((w) => w === n) ?? 3;
}

/** The dashed trailing-average line drawn over a chart's bars. */
function averageLine(dataKey: string, window: AverageWindow) {
  return (
    <Line
      type="monotone"
      dataKey={dataKey}
      name={`${window}-month average`}
      stroke="var(--text-h)"
      strokeWidth={2}
      strokeDasharray="5 4"
      dot={false}
      activeDot={false}
      connectNulls={false}
      isAnimationActive={false}
    />
  );
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
  averageDataKey,
  color,
  averageWindow,
  onBarClick,
}: {
  data: ChartRow[];
  dataKey: string;
  averageDataKey: string;
  color: string;
  averageWindow: AverageWindow;
  onBarClick: (state: MouseHandlerDataParam) => void;
}) {
  return (
    <div className="category-chart">
      <h3>{dataKey}</h3>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} syncId={DASHBOARD_SYNC_ID} onClick={onBarClick} className="clickable-chart">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" stroke="var(--text)" fontSize={11} />
          <YAxis stroke="var(--text)" fontSize={11} width={40} />
          <Tooltip
            formatter={(value) => rupee.format(Number(value))}
            contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8 }}
          />
          <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} />
          {averageLine(averageDataKey, averageWindow)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

interface Props {
  categories: CategoryOption[];
  /** The enabled modules: each section below renders only when the module
   * it reads is on, so a disabled module's API is never called. */
  modules: ReadonlySet<ModuleName>;
  onSelectMonth: (year: number, month: number) => void;
  onSelectUpcomingItem: (item: UpcomingItem) => void;
}

// The modules GET /api/overview reads; with none of them on there is no
// overview to show (an expenses-only deployment).
const OVERVIEW_MODULES: ModuleName[] = ["finances", "debts", "emi", "credit-cards", "subscriptions"];

export function Dashboard(props: Props) {
  const { modules, onSelectUpcomingItem } = props;
  return (
    <div className="dashboard">
      {OVERVIEW_MODULES.some((m) => modules.has(m)) && (
        <DashboardOverview modules={modules} onSelectUpcomingItem={onSelectUpcomingItem} />
      )}

      {modules.has("emi") && <EmiProjectionChart />}

      {modules.has("expenses") && <YearlyOverview {...props} />}
    </div>
  );
}

/** The expense charts: the year's stacked monthly totals plus one mini-chart
 * per category, each clickable through to that month's Expenses. */
function YearlyOverview({ categories, onSelectMonth }: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<MonthSummary[]>([]);
  // The previous year's months, so a trailing average can start in January.
  // Null when there is no earlier year or it couldn't be read: the averages
  // then start once the selected year has a full window of its own.
  const [previousData, setPreviousData] = useState<MonthSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [averageWindow, setAverageWindow] = useState<AverageWindow>(getInitialAverageWindow);

  useEffect(() => {
    localStorage.setItem(AVERAGE_WINDOW_KEY, String(averageWindow));
  }, [averageWindow]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const previous =
      year - 1 >= EARLIEST_YEAR ? getYearSummary(year - 1).catch(() => null) : Promise.resolve(null);
    Promise.all([getYearSummary(year), previous])
      .then(([current, prior]) => {
        setData(current);
        setPreviousData(prior);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [year]);

  const averagesOf = (pick: (m: MonthSummary) => number) =>
    trailingAverages(
      previousData ? knownMonths(year - 1, previousData.map(pick)) : Array.from({ length: 12 }, () => null),
      knownMonths(year, data.map(pick)),
      averageWindow,
    );
  const totalAverage = averagesOf((m) => m.total);
  const categoryAverages = categories.map((c) => averagesOf((m) => m.categoryTotals[c.id] ?? 0));

  const chartData: ChartRow[] = data.map((m, i) => ({
    name: MONTH_ABBR[m.month - 1],
    month: m.month,
    ...Object.fromEntries(categories.map((c) => [c.label, m.categoryTotals[c.id] ?? 0])),
    [TOTAL_AVERAGE_KEY]: totalAverage[i] ?? null,
    ...Object.fromEntries(categories.map((c, ci) => [averageKey(c.id), categoryAverages[ci][i] ?? null])),
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
    <>
      <div className="dashboard-header">
        <h2>Yearly Overview</h2>
        <div className="dashboard-controls">
          <select
            className="select"
            aria-label="Average line"
            value={averageWindow}
            onChange={(e) => setAverageWindow(Number(e.target.value) as AverageWindow)}
          >
            {AVERAGE_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}-month average
              </option>
            ))}
          </select>
          <YearSelect value={year} onChange={setYear} />
        </div>
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
              <ComposedChart data={chartData} onClick={handleBarClick} syncId={DASHBOARD_SYNC_ID} className="clickable-chart">
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
                {averageLine(TOTAL_AVERAGE_KEY, averageWindow)}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="dashboard-hint">
            Click a month to view or add entries for it. The dashed line is the {averageWindow}-month average.
          </p>

          <div className="category-charts">
            {categories.map((c) => (
              <CategoryMiniChart
                key={c.id}
                data={chartData}
                dataKey={c.label}
                averageDataKey={averageKey(c.id)}
                color={c.bg}
                averageWindow={averageWindow}
                onBarClick={handleBarClick}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
