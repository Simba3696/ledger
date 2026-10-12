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
import { getYearSummary, type MonthSummary, type UpcomingItem } from "../api";
import { EARLIEST_YEAR } from "../constants";
import { AVERAGE_WINDOWS, knownMonths, trailingAverages, type AverageWindow } from "../movingAverage";
import { CATEGORY_SWATCH } from "../categoryColors";
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

interface ChartRow {
  name: string;
  month: number;
  Food: number;
  Transportation: number;
  Rent: number;
  Other: number;
  /** Trailing average of the month total and of each category, keyed
   * "<series> average". Null where there isn't a full window of data. */
  "Total average": number | null;
  "Food average": number | null;
  "Transportation average": number | null;
  "Rent average": number | null;
  "Other average": number | null;
}

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

const CATEGORY_CHARTS = [
  { dataKey: "Food", color: CATEGORY_SWATCH.food.bg },
  { dataKey: "Transportation", color: CATEGORY_SWATCH.transportation.bg },
  { dataKey: "Rent", color: CATEGORY_SWATCH.rent.bg },
  { dataKey: "Other", color: CATEGORY_SWATCH.other.bg },
] as const;

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
  averageWindow,
  onBarClick,
}: {
  data: ChartRow[];
  dataKey: (typeof CATEGORY_CHARTS)[number]["dataKey"];
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
          {averageLine(`${dataKey} average`, averageWindow)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

interface Props {
  onSelectMonth: (year: number, month: number) => void;
  onSelectUpcomingItem: (item: UpcomingItem) => void;
}

export function Dashboard({ onSelectMonth, onSelectUpcomingItem }: Props) {
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
  const foodAverage = averagesOf((m) => m.food);
  const transportationAverage = averagesOf((m) => m.transportation);
  const rentAverage = averagesOf((m) => m.rent);
  const otherAverage = averagesOf((m) => m.other);

  const chartData: ChartRow[] = data.map((m, i) => ({
    name: MONTH_ABBR[m.month - 1],
    month: m.month,
    Food: m.food,
    Transportation: m.transportation,
    Rent: m.rent,
    Other: m.other,
    "Total average": totalAverage[i] ?? null,
    "Food average": foodAverage[i] ?? null,
    "Transportation average": transportationAverage[i] ?? null,
    "Rent average": rentAverage[i] ?? null,
    "Other average": otherAverage[i] ?? null,
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
                {averageLine("Total average", averageWindow)}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="dashboard-hint">
            Click a month to view or add entries for it. The dashed line is the {averageWindow}-month average.
          </p>

          <div className="category-charts">
            {CATEGORY_CHARTS.map((c) => (
              <CategoryMiniChart
                key={c.dataKey}
                data={chartData}
                dataKey={c.dataKey}
                color={c.color}
                averageWindow={averageWindow}
                onBarClick={handleBarClick}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
