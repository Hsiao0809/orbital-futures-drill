"use client";

import { CandlestickSeries, ColorType, createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";

type Candle = { time: number; open: number; high: number; low: number; close: number };
const FUTURE_GAP_PX = 120;

export default function TrainingChart({ candles, visible, loading }: { candles: Candle[]; visible: number; loading: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [barSpacing, setBarSpacing] = useState(7);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, { width: host.current.clientWidth, height: host.current.clientHeight, layout: { background: { type: ColorType.Solid, color: "#0d1117" }, textColor: "#87909b" }, grid: { vertLines: { color: "rgba(255,255,255,0.035)" }, horzLines: { color: "rgba(255,255,255,0.055)" } }, rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" }, timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, barSpacing, rightOffsetPixels: FUTURE_GAP_PX }, handleScale: true, handleScroll: true, crosshair: { vertLine: { color: "rgba(200,244,102,0.35)" }, horzLine: { color: "rgba(200,244,102,0.25)" } } });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, { upColor: "#6ee7b7", downColor: "#f26c7c", borderUpColor: "#6ee7b7", borderDownColor: "#f26c7c", wickUpColor: "#6ee7b7", wickDownColor: "#f26c7c" });
    series.setData(candles.slice(0, visible).map((candle) => ({ ...candle, time: Math.floor(candle.time / 1000) as UTCTimestamp })));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver((entries) => { const box = entries[0]?.contentRect; if (box) chart.applyOptions({ width: box.width, height: box.height }); });
    observer.observe(host.current);
    return () => { observer.disconnect(); chartRef.current = null; chart.remove(); };
  }, [candles, visible, barSpacing]);

  const resetZoom = () => { setBarSpacing(7); chartRef.current?.timeScale().fitContent(); };

  return <div className="tv-chart"><div ref={host} className="tv-chart-host" /><div className="chart-zoom" aria-label="圖表縮放"><button onClick={() => setBarSpacing((value) => Math.min(22, value + 1))}>＋</button><button onClick={() => setBarSpacing((value) => Math.max(3, value - 1))}>－</button><button className="zoom-reset" onClick={resetZoom}>重設</button></div>{loading && <div className="chart-loading">載入真實歷史 K 線…</div>}</div>;
}
