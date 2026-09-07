import { useEffect, useState } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { getEmiMonthlyProjection, type EmiMonthlyProjection } from "../api";
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

export function EmiProjectionChart() {
  const [data, setData] = useState<EmiMonthlyProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getEmiMonthlyProjection()
      .then(setData)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

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
                  <XAxis dataKey="month" stroke="var(--text)" fontSize={12} />
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
        </div>
      )}
    </div>
  );
}
