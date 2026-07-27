"use client";

import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle } from "@/lib/engine/types.ts";

export type PriceLine = {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
};

type Props = {
  candles: Candle[];
  /** How many candles from the start are revealed. The rest stay hidden. */
  visible: number;
  /** Horizontal reference lines: entry, stop, target. */
  lines?: PriceLine[];
  /** Bars of empty space kept on the right so hidden candles feel withheld. */
  futureGapPx?: number;
  loading?: boolean;
  error?: string | null;
  height?: number;
};

const THEME = {
  layout: { background: { type: ColorType.Solid, color: "#0d1117" }, textColor: "#868d97" },
  grid: {
    vertLines: { color: "rgba(255,255,255,0.035)" },
    horzLines: { color: "rgba(255,255,255,0.05)" },
  },
  rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
  crosshair: {
    vertLine: { color: "rgba(200,244,102,0.35)", labelBackgroundColor: "#2a3320" },
    horzLine: { color: "rgba(200,244,102,0.25)", labelBackgroundColor: "#2a3320" },
  },
};

const SERIES_STYLE = {
  upColor: "#6ee7b7",
  downColor: "#f26c7c",
  borderUpColor: "#6ee7b7",
  borderDownColor: "#f26c7c",
  wickUpColor: "#6ee7b7",
  wickDownColor: "#f26c7c",
};

export default function Chart({
  candles,
  visible,
  lines = [],
  futureGapPx = 108,
  loading = false,
  error = null,
  height = 420,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRefs = useRef<IPriceLine[]>([]);

  // Create the chart once. Data and price lines are pushed by the effects
  // below so a re-render never tears down and rebuilds the canvas.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const chart = createChart(element, {
      width: element.clientWidth,
      height: element.clientHeight,
      ...THEME,
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        rightOffsetPixels: futureGapPx,
      },
      handleScale: true,
      handleScroll: true,
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(CandlestickSeries, SERIES_STYLE);

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) chart.applyOptions({ width: box.width, height: box.height });
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      lineRefs.current = [];
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [futureGapPx]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(
      candles.slice(0, visible).map((candle) => ({
        time: Math.floor(candle.time / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles, visible]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of lineRefs.current) series.removePriceLine(line);
    lineRefs.current = lines.map((line) =>
      series.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: line.label,
      }),
    );
  }, [lines]);

  const hidden = Math.max(0, candles.length - visible);

  return (
    <div className="chart-frame" style={{ height }} aria-label="歷史 K 線圖表">
      <div ref={host} className="chart-host" />
      {hidden > 0 && !loading && !error && (
        <div className="chart-fog">
          <span>未揭露</span>
          <strong>{hidden} 根</strong>
        </div>
      )}
      {loading && <div className="chart-overlay">正在載入真實歷史 K 線…</div>}
      {error && <div className="chart-overlay">{error}</div>}
    </div>
  );
}
