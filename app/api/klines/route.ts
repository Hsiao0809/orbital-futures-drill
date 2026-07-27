import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const INTERVALS = new Set(["5m", "15m", "1h", "4h"]);
const UPSTREAM = "https://fapi.binance.com/fapi/v1/klines";

type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get("symbol") || "").toUpperCase();
  const interval = searchParams.get("interval") || "15m";
  // Drills need a long tape to sample non-overlapping windows from.
  const limit = Math.min(1000, Math.max(120, Number(searchParams.get("limit")) || 500));

  if (!/^[A-Z0-9]{5,24}$/.test(symbol) || !INTERVALS.has(interval)) {
    return NextResponse.json({ error: "無效的合約代號或 K 線週期。" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${UPSTREAM}?symbol=${symbol}&interval=${interval}&limit=${limit}`, {
      headers: { "User-Agent": "orbital-trainer/2.0" },
      cache: "no-store",
    });

    if (!upstream.ok) {
      const body = (await upstream.json().catch(() => null)) as { code?: number; msg?: string } | null;
      const error =
        body?.code === -1121
          ? "這個代號目前不是 Binance 可交易的 USDⓈ-M 永續合約，請重新選擇。"
          : `暫時無法取得歷史 K 線（HTTP ${upstream.status}${body?.msg ? `：${body.msg}` : ""}）。`;
      return NextResponse.json({ error }, { status: 502 });
    }

    const rows: unknown = await upstream.json();
    if (!Array.isArray(rows)) {
      return NextResponse.json({ error: "上游回傳格式異常。" }, { status: 502 });
    }

    // Drop the final row: the newest candle is still forming, and training on a
    // partial bar would leak information the tape had not actually produced.
    const candles = rows.slice(0, -1).map((row) => {
      const item = row as BinanceKline;
      return {
        time: Number(item[0]),
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5]),
      };
    });

    return NextResponse.json(
      { source: "Binance USDⓈ-M Futures", symbol, interval, candles },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "目前無法連線至歷史資料來源。" }, { status: 502 });
  }
}
