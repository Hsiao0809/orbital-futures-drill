import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const intervals = new Set(["5m", "15m", "1h", "4h"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get("symbol") || "").toUpperCase();
  const interval = searchParams.get("interval") || "15m";
  const limit = Math.min(500, Math.max(100, Number(searchParams.get("limit")) || 260));
  if (!/^[A-Z0-9]{5,24}$/.test(symbol) || !intervals.has(interval)) return NextResponse.json({ error: "無效的合約或週期" }, { status: 400 });
  try {
    const upstream = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { headers: { "User-Agent": "orbital-futures-drill/1.0" }, cache: "no-store" });
    if (!upstream.ok) return NextResponse.json({ error: "此代號目前不是 Binance 可交易的 USDⓈ-M 永續合約；請從下拉選單重新選擇。" }, { status: 502 });
    const rows: unknown = await upstream.json();
    if (!Array.isArray(rows)) return NextResponse.json({ error: "Binance 回傳格式異常" }, { status: 502 });
    const candles = rows.slice(0, -1).map((row: unknown) => {
      const item = row as [number, string, string, string, string];
      return { time: Number(item[0]), open: Number(item[1]), high: Number(item[2]), low: Number(item[3]), close: Number(item[4]) };
    });
    return NextResponse.json({ source: "Binance USDⓈ-M Futures", symbol, interval, candles }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "目前無法連線至 Binance 歷史資料" }, { status: 502 });
  }
}
