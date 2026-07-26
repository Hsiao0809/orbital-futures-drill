import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const preferredNames: Record<string, string> = {
  BTCUSDT: "Bitcoin", ETHUSDT: "Ethereum", SOLUSDT: "Solana", XRPUSDT: "XRP", DOGEUSDT: "Dogecoin", HYPEUSDT: "Hyperliquid", WIFUSDT: "dogwifhat", FARTCOINUSDT: "Fartcoin", PENGUUSDT: "Pudgy Penguins", ENAUSDT: "Ethena", SUIUSDT: "Sui",
};

export async function GET() {
  try {
    const upstream = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", { headers: { "User-Agent": "orbital-futures-drill/1.0" }, cache: "no-store" });
    if (!upstream.ok) throw new Error();
    const data = await upstream.json() as { symbols?: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }> };
    const contracts = (data.symbols || [])
      .filter((item) => item.contractType === "PERPETUAL" && item.quoteAsset === "USDT" && item.status === "TRADING")
      .map((item) => ({ symbol: item.symbol, name: preferredNames[item.symbol] || item.baseAsset }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    return NextResponse.json({ source: "Binance USDⓈ-M Futures", contracts }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "目前無法取得 Binance 可交易合約清單" }, { status: 502 });
  }
}
