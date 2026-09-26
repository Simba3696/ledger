import { useEffect, useState } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { getEmiMonthlyProjection, type EmiMonthlyProjection, type EmiProjectionScale } from "../api";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import "./EmiProjectionChart.css";

interface ChartRow {
  month: string; // display label, e.g. "Sep 2026"
  totalAmount: number;
  count: number;
}

function formatMonthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

const SCALE_OPTIONS: { value: EmiProjectionScale; label: string }[] = [
  { value: 6, label: "6 Months" },
  { value: 12, label: "1 Year" },
  { value: 24, label: "2 Years" },
  { value: 60, label: "5 Years" },
  { value: "auto", label: "Until Paid Off" },
];

const SCALE_KEY = "ledger-emi-projection-scale";

function getInitialScale(): EmiProjectionScale {
  const stored = localStorage.getItem(SCALE_KEY);
  if (stored === "auto") return "auto";
  const n = Number(stored);
  return n === 6 || n === 12 || n === 24 || n === 60 ? n : 12;
}

export function EmiProjectionChart() {
  const [data, setData] = useState<EmiMonthlyProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<EmiProjectionScale>(getInitialScale);

  useEffect(() => {
    localStorage.setItem(SCALE_KEY, String(scale));
  }, [scale]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getEmiMonthlyProjection(scale)
      .then(setData)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [scale]);

  const chartData: ChartRow[] = data.map((m) => ({
    month: formatMonthLabel(m.month),
    totalAmount: m.totalAmount,
    count: m.count,
  }));

  // Every month comes back present but zeroed when there are no active
  // EMIs at all — a flat, empty-looking chart is worse than just saying so.
  const hasAnyEmis = data.some((m) => m.count > 0);

  return (
    <div className="emi-projection">
      <div className="emi-projection-header">
        <h2>Upcoming EMIs</h2>
        <select
          className="select"
          value={String(scale)}
          onChange={(e) => setScale(e.target.value === "auto" ? "auto" : (Number(e.target.value) as EmiProjectionScale))}
        >
          {SCALE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      {!error && (
        <div className="emi-projection-body">
          <LoadingOverlay active={loading} />

          {!loading && !hasAnyEmis && <p className="empty">No EMIs due in the coming months.</p>}

          {(loading || hasAnyEmis) && (
            <div className="emi-projection-chart-wrap">
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="month" stroke="var(--text)" tick={false} tickLine={false} />
                  <YAxis
                    yAxisId="amount"
                    stroke="var(--text)"
                    fontSize={12}
                    width={70}
                    tickFormatter={(value) => rupee.format(Number(value))}
                  />
                  <YAxis yAxisId="count" orientation="right" stroke="var(--text)" fontSize={12} width={30} allowDecimals={false} />
                  <Tooltip
                    formatter={(value, name) => (name === "EMI Amount" ? rupee.format(Number(value)) : value)}
                    contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8 }}
                  />
                  <Legend />
                  <Bar yAxisId="amount" dataKey="totalAmount" name="EMI Amount" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  <Line
                    yAxisId="count"
                    type="monotone"
                    dataKey="count"
                    name="Number of EMIs"
                    stroke="var(--text-h)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* The x-axis has no visible labels (see the XAxis above) so a
              month is only ever revealed via the tooltip — worth a hint,
              since there's nothing else on the chart suggesting that's
              possible, especially by touch. */}
          {!loading && hasAnyEmis && <p className="emi-projection-hint">Tap or hover a bar to see its month</p>}
        </div>
      )}
    </div>
  );
}
