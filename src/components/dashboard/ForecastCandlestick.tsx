/**
 * Recharts v3 forecast overlays.
 *
 * In v3 `Customized` no longer injects xAxisMap/yAxisMap.
 * Instead, render these components as *direct children* of <BarChart> and
 * they pull the axis scales via the v3 hook API.
 */
"use client";

import { useXAxisScale, useYAxisScale } from "recharts";

export interface CandleForecast {
  low:  number;
  base: number;
  high: number;
}

function fmtLabel(v: number, format: "currency" | "number"): string {
  if (format === "currency") {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
    return `$${v}`;
  }
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

// ---------------------------------------------------------------------------
// ForecastLines — three short horizontal notches above the current bar
// Conservative (amber dashed) · Base (indigo solid) · Optimistic (emerald dashed)
// ---------------------------------------------------------------------------

interface ForecastLinesProps {
  periodLabel: string;
  forecast:    CandleForecast;
  format?:     "currency" | "number";
}

export function ForecastLines({ periodLabel, forecast, format = "currency" }: ForecastLinesProps) {
  // v3: pull scales directly from chart context — no xAxisMap/yAxisMap needed
  const xScale = useXAxisScale() as ((v: string) => number) & { bandwidth?: () => number } | undefined;
  const yScale = useYAxisScale() as ((v: number) => number) | undefined;

  if (!xScale || !yScale) return null;

  const xLeft = xScale(periodLabel);
  if (xLeft === undefined || isNaN(xLeft as number)) return null;

  const bandwidth = typeof xScale.bandwidth === "function" ? xScale.bandwidth() : 40;
  const cx        = (xLeft as number) + bandwidth / 2;
  const lineW     = Math.max(bandwidth * 0.85, 28);
  const x1        = cx - lineW / 2;
  const x2        = cx + lineW / 2;
  const labelX    = x2 + 5;

  const yLow  = yScale(forecast.low);
  const yBase = yScale(forecast.base);
  const yHigh = yScale(forecast.high);

  return (
    <g>
      {/* Optimistic — emerald dashed */}
      <line x1={x1} y1={yHigh} x2={x2} y2={yHigh}
        stroke="#059669" strokeWidth={2} strokeDasharray="4 2" strokeLinecap="round" />
      <text x={labelX} y={yHigh + 4} fontSize={9} fill="#059669" fontWeight={700}>
        {fmtLabel(forecast.high, format)}
      </text>

      {/* Base — indigo solid */}
      <line x1={x1} y1={yBase} x2={x2} y2={yBase}
        stroke="#4f46e5" strokeWidth={2.5} strokeLinecap="round" />
      <text x={labelX} y={yBase + 4} fontSize={9} fill="#4f46e5" fontWeight={700}>
        {fmtLabel(forecast.base, format)}
      </text>

      {/* Conservative — amber dashed */}
      <line x1={x1} y1={yLow} x2={x2} y2={yLow}
        stroke="#d97706" strokeWidth={2} strokeDasharray="4 2" strokeLinecap="round" />
      <text x={labelX} y={yLow + 4} fontSize={9} fill="#d97706" fontWeight={700}>
        {fmtLabel(forecast.low, format)}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// ForecastCandlestick — full OHLC candle (kept for reference, not currently used)
// ---------------------------------------------------------------------------

interface ForecastCandlestickProps {
  periodLabel: string;
  forecast:    CandleForecast;
  format?:     "currency" | "number";
}

export function ForecastCandlestick({ periodLabel, forecast, format = "currency" }: ForecastCandlestickProps) {
  const xScale = useXAxisScale() as ((v: string) => number) & { bandwidth?: () => number } | undefined;
  const yScale = useYAxisScale() as ((v: number) => number) | undefined;

  if (!xScale || !yScale) return null;

  const xLeft = xScale(periodLabel);
  if (xLeft === undefined || isNaN(xLeft as number)) return null;

  const bandwidth = typeof xScale.bandwidth === "function" ? xScale.bandwidth() : 40;
  const cx        = (xLeft as number) + bandwidth / 2;
  const bodyW     = Math.max(bandwidth * 0.45, 16);
  const capW      = bodyW * 0.65;
  const wickW     = 1.5;

  const open  = (forecast.base + forecast.high) / 2;
  const close = (forecast.base + forecast.low)  / 2;

  const yHigh  = yScale(forecast.high);
  const yOpen  = yScale(open);
  const yBase  = yScale(forecast.base);
  const yClose = yScale(close);
  const yLow   = yScale(forecast.low);

  const labelX = cx + bodyW / 2 + 6;

  return (
    <g>
      <line x1={cx} y1={yHigh} x2={cx} y2={yOpen}
        stroke="#4338ca" strokeWidth={wickW} strokeLinecap="round" />
      <line x1={cx - capW / 2} y1={yHigh} x2={cx + capW / 2} y2={yHigh}
        stroke="#4338ca" strokeWidth={2} strokeLinecap="round" />
      <rect x={cx - bodyW / 2} y={yOpen} width={bodyW} height={Math.max(yClose - yOpen, 4)}
        fill="#c7d2fe" fillOpacity={0.85} stroke="#4338ca" strokeWidth={1.5} rx={2} />
      <line x1={cx - bodyW / 2} y1={yBase} x2={cx + bodyW / 2} y2={yBase}
        stroke="#3730a3" strokeWidth={2.5} strokeLinecap="round" />
      <line x1={cx} y1={yClose} x2={cx} y2={yLow}
        stroke="#4338ca" strokeWidth={wickW} strokeLinecap="round" />
      <line x1={cx - capW / 2} y1={yLow} x2={cx + capW / 2} y2={yLow}
        stroke="#4338ca" strokeWidth={2} strokeLinecap="round" />
      <text x={labelX} y={yHigh + 3} fontSize={9} fill="#4338ca" fontWeight="600">
        {fmtLabel(forecast.high, format)}
      </text>
      <text x={labelX} y={yBase + 3} fontSize={9} fill="#312e81" fontWeight="700">
        {fmtLabel(forecast.base, format)}
      </text>
      <text x={labelX} y={yLow + 3} fontSize={9} fill="#4338ca" fontWeight="600">
        {fmtLabel(forecast.low, format)}
      </text>
      <rect x={cx - 24} y={yHigh - 21} width={48} height={15}
        fill="#eef2ff" stroke="#c7d2fe" strokeWidth={1} rx={4} />
      <text x={cx} y={yHigh - 10} fontSize={8} fill="#4f46e5" fontWeight="700" textAnchor="middle">
        FORECAST
      </text>
    </g>
  );
}
