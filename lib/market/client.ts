"use client";

// Market data access for the browser.
//
// Requests go through this app's own `/api/klines` route rather than straight
// to Binance so the upstream host, the symbol allow-list and the error copy
// live in one place. Responses are memoised for the session: a drill re-roll
// should not re-download 500 candles.

import type { Candle, Interval } from "../engine/types.ts";

export type Contract = { symbol: string; name: string };

export const INTERVALS: Interval[] = ["5m", "15m", "1h", "4h"];

const candleCache = new Map<string, Candle[]>();
let contractCache: Contract[] | null = null;

export const FALLBACK_CONTRACTS: Contract[] = [
  { symbol: "BTCUSDT", name: "Bitcoin" },
  { symbol: "ETHUSDT", name: "Ethereum" },
  { symbol: "SOLUSDT", name: "Solana" },
  { symbol: "BNBUSDT", name: "BNB" },
  { symbol: "XRPUSDT", name: "XRP" },
  { symbol: "DOGEUSDT", name: "Dogecoin" },
  { symbol: "LINKUSDT", name: "Chainlink" },
  { symbol: "AVAXUSDT", name: "Avalanche" },
  { symbol: "ARBUSDT", name: "Arbitrum" },
  { symbol: "SUIUSDT", name: "Sui" },
];

export async function fetchContracts(): Promise<Contract[]> {
  if (contractCache) return contractCache;
  try {
    const response = await fetch("/api/contracts");
    if (!response.ok) throw new Error("contracts unavailable");
    const payload = (await response.json()) as { contracts?: Contract[] };
    const contracts = payload.contracts?.length ? payload.contracts : FALLBACK_CONTRACTS;
    contractCache = contracts;
    return contracts;
  } catch {
    return FALLBACK_CONTRACTS;
  }
}

export type CandleResult = { candles: Candle[] } | { error: string };

export async function fetchCandles(
  symbol: string,
  interval: Interval,
  limit = 500,
): Promise<CandleResult> {
  const key = `${symbol}:${interval}:${limit}`;
  const cached = candleCache.get(key);
  if (cached) return { candles: cached };
  try {
    const response = await fetch(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`);
    const payload = (await response.json()) as { candles?: Candle[]; error?: string };
    if (!response.ok || !payload.candles) {
      return { error: payload.error ?? "無法取得歷史 K 線資料。" };
    }
    if (payload.candles.length < 120) {
      return { error: "這個合約的歷史資料太短，無法產生訓練情境。請換一個合約或週期。" };
    }
    candleCache.set(key, payload.candles);
    return { candles: payload.candles };
  } catch {
    return { error: "目前無法連線至歷史資料來源，請稍後重試。" };
  }
}

export function clearCandleCache(): void {
  candleCache.clear();
}
