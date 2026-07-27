"use client";

// Market data access for the browser.
//
// Two paths, tried in this order:
//
//   1. Direct from the browser to Binance. The request leaves the learner's own
//      connection, which is the one most likely to be permitted and costs the
//      worker nothing. Binance's public market endpoints send
//      `Access-Control-Allow-Origin: *`, so this works cross-origin.
//   2. This app's `/api/klines` proxy, as a fallback.
//
// The order matters and was learned the hard way: Binance answers requests
// originating from Cloudflare Workers egress IPs with HTTP 403, so a
// worker-first strategy fails for every deployed user even when their own
// connection would have worked fine. The proxy is still worth keeping — it
// covers browsers where a corporate policy or extension blocks the third-party
// request — but it cannot be the primary path.
//
// Responses are memoised for the session: re-rolling a drill should not
// re-download 500 candles.

import type { Candle, Interval } from "../engine/types.ts";

export type Contract = { symbol: string; name: string };

export const INTERVALS: Interval[] = ["5m", "15m", "1h", "4h"];

const BINANCE = "https://fapi.binance.com/fapi/v1";
/** Below this a scenario cannot be built, so treat it as no data at all. */
const MIN_CANDLES = 120;

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

type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

/** Binance returns arrays of strings; the last row is the still-forming candle. */
function toCandles(rows: unknown): Candle[] | null {
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, -1).map((row) => {
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
}

export async function fetchContracts(): Promise<Contract[]> {
  if (contractCache) return contractCache;

  try {
    const response = await fetch(`${BINANCE}/exchangeInfo`, { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as {
        symbols?: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }>;
      };
      const contracts = (data.symbols ?? [])
        .filter((item) => item.contractType === "PERPETUAL" && item.quoteAsset === "USDT" && item.status === "TRADING")
        .map((item) => ({ symbol: item.symbol, name: item.baseAsset }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      if (contracts.length) {
        contractCache = contracts;
        return contracts;
      }
    }
  } catch {
    // Fall through to the proxy.
  }

  try {
    const response = await fetch("/api/contracts");
    if (response.ok) {
      const payload = (await response.json()) as { contracts?: Contract[] };
      if (payload.contracts?.length) {
        contractCache = payload.contracts;
        return payload.contracts;
      }
    }
  } catch {
    // Fall through to the built-in list.
  }

  return FALLBACK_CONTRACTS;
}

export type CandleResult = { candles: Candle[] } | { error: string };

/** Path 1: straight from the learner's browser. */
async function fetchDirect(symbol: string, interval: Interval, limit: number): Promise<Candle[] | null> {
  try {
    const response = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const candles = toCandles(await response.json());
    return candles && candles.length >= MIN_CANDLES ? candles : null;
  } catch {
    return null;
  }
}

/** Path 2: through this app's own worker. */
async function fetchViaProxy(symbol: string, interval: Interval, limit: number): Promise<CandleResult> {
  try {
    const response = await fetch(
      `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
    );
    const payload = (await response.json()) as { candles?: Candle[]; error?: string };
    if (!response.ok || !payload.candles) {
      return { error: payload.error ?? "無法取得歷史 K 線資料。" };
    }
    if (payload.candles.length < MIN_CANDLES) {
      return { error: "這個合約的歷史資料太短，無法產生訓練情境。請換一個合約或週期。" };
    }
    return { candles: payload.candles };
  } catch {
    return { error: "目前無法連線至歷史資料來源，請稍後重試。" };
  }
}

export async function fetchCandles(
  symbol: string,
  interval: Interval,
  limit = 500,
): Promise<CandleResult> {
  const key = `${symbol}:${interval}:${limit}`;
  const cached = candleCache.get(key);
  if (cached) return { candles: cached };

  const direct = await fetchDirect(symbol, interval, limit);
  if (direct) {
    candleCache.set(key, direct);
    return { candles: direct };
  }

  const proxied = await fetchViaProxy(symbol, interval, limit);
  if ("candles" in proxied) {
    candleCache.set(key, proxied.candles);
    return proxied;
  }

  // Both paths failed. Say which drills still work rather than leaving the
  // learner staring at a dead screen.
  return {
    error:
      "無法取得歷史 K 線資料。這通常是因為你所在的地區無法連線到 Binance。" +
      "不需要行情的題型（部位計算、規則守門、情緒控制）仍然可以正常使用。",
  };
}

export function clearCandleCache(): void {
  candleCache.clear();
}
