// Rebuilds the K-line teaching pack from the recent 24h gainers/losers board.
//
//   node --experimental-strip-types scripts/build-case-pack.ts
//
// What it does: takes the top movers, downloads their recent tape, screens
// every window with `lib/engine/cases.ts`, and writes the highest teaching-value
// window per archetype into `lib/market/casePack.ts`.
//
// Why the board: the material is supposed to teach the mistakes that actually
// empty evaluation accounts, and those mistakes cluster on exactly the symbols
// the leaderboard advertises — extended runs, tripled ATR, stops parked inside
// a range that no longer exists.
//
// Data source. The product's drills use Binance USDⓈ-M perpetuals, so the
// generator asks for those first. Binance answers some networks (including
// Cloudflare egress and parts of the CI estate) with HTTP 451, so there is a
// documented fallback to Binance's public spot mirror. Whichever one answered
// is recorded on every case and shown in the UI, because the perp tape and the
// spot tape are not the same series and the material must not blur them.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CASE_CONTEXT_BARS,
  ARCHETYPES,
  caseProblems,
  classifyWindow,
  isContinuousTape,
  type BoardSnapshot,
  type CaseArchetype,
  type CaseStudy,
} from "../lib/engine/cases.ts";
import type { Candle, Interval, Side } from "../lib/engine/types.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type Source = { label: string; base: string; tickerPath: string; klinePath: string };

const PERP: Source = {
  label: "Binance USDⓈ-M 永續合約",
  base: "https://fapi.binance.com/fapi/v1",
  tickerPath: "/ticker/24hr",
  klinePath: "/klines",
};

const SPOT: Source = {
  label: "Binance 現貨（data-api.binance.vision 公開鏡像）",
  base: "https://data-api.binance.vision/api/v3",
  tickerPath: "/ticker/24hr",
  klinePath: "/klines",
};

type Ticker = { symbol: string; priceChangePercent: string; quoteVolume: string };

/** Leveraged tokens and fiat/stable pairs are not our tape. */
const EXCLUDE = /(UP|DOWN|BULL|BEAR)USDT$/;

/**
 * Binance lists tokenised US equities against USDT — SOXLB (a 3× semiconductor
 * ETF), MUB, QQQB, NVDAB and about fifty more — and they ride the same 24h
 * board as everything else. They have to go: a leveraged-ETF tape teaches
 * nothing transferable about perpetual futures, which is what this product
 * trains.
 *
 * There is no property of the data that separates them. They trade 24/7 with
 * real volume and unbroken candles, so the continuity check below does not
 * catch them. What they do share is a naming convention: a US ticker with a
 * "B" suffix. That over-captures the handful of genuine crypto assets whose
 * ticker also ends in B, which are allow-listed here — only ones liquid enough
 * to ever reach the board need to be on the list.
 *
 * This whole filter is a property of the *fallback* source. The USDⓈ-M perp
 * universe contains no equities, so on the primary path it excludes nothing.
 */
const EQUITY_SUFFIX = /^[A-Z]{1,6}B$/;
const CRYPTO_B_BASES = new Set(["BNB", "SHIB", "ARB", "TRB", "BB", "CKB", "DGB"]);
const isTokenisedEquity = (base: string) => EQUITY_SUFFIX.test(base) && !CRYPTO_B_BASES.has(base);
const STABLE =
  /^(USDC|FDUSD|TUSD|BUSD|DAI|EURI|USDP|AEUR|XUSD|USD1|BFUSD|EUR|GBP|JPY|BRL|TRY|ARS|ZAR|MXN|COP|PLN|RON|CZK|UAH|NGN|IDRT)USDT$/;
/** Same shape the app's own kline proxy accepts. */
const SYMBOL = /^[A-Z0-9]{5,24}$/;

/** Below this the tape is too thin for the fills a lesson implies. */
const MIN_QUOTE_VOLUME = 5_000_000;
const MOVERS_PER_SIDE = 12;
const INTERVALS: Interval[] = ["15m", "1h"];
const HORIZON = 24;
const KLINE_LIMIT = 500;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": "orbital-trainer/case-pack" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/** First source that answers wins, and the whole pack is built from it. */
async function resolveSource(): Promise<{ source: Source; tickers: Ticker[] }> {
  const failures: string[] = [];
  for (const source of [PERP, SPOT]) {
    try {
      const rows = (await getJson(`${source.base}${source.tickerPath}`)) as Ticker[];
      if (Array.isArray(rows) && rows.length) {
        console.log(`資料來源：${source.label}`);
        return { source, tickers: rows };
      }
      failures.push(`${source.base}: 回傳空清單`);
    } catch (error) {
      failures.push(`${source.base}: ${(error as Error).message}`);
    }
  }
  throw new Error(`沒有可用的行情來源：\n  ${failures.join("\n  ")}`);
}

function board(tickers: Ticker[]): Array<Ticker & { snapshot: BoardSnapshot }> {
  const universe = tickers
    .filter(
      (row) =>
        row.symbol.endsWith("USDT") &&
        SYMBOL.test(row.symbol) &&
        !EXCLUDE.test(row.symbol) &&
        !STABLE.test(row.symbol) &&
        !isTokenisedEquity(row.symbol.replace(/USDT$/, "")) &&
        Number(row.quoteVolume) >= MIN_QUOTE_VOLUME,
    )
    .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent));

  const snap = (row: Ticker, side: BoardSnapshot["side"], rank: number) => ({
    ...row,
    snapshot: {
      side,
      rank,
      changePct: Number(row.priceChangePercent),
      quoteVolumeUsd: Number(row.quoteVolume),
    } satisfies BoardSnapshot,
  });

  // A thin universe can put the same symbol on both ends of the board; the
  // gainer reading is the one that was ranked first, so it wins.
  const seen = new Set<string>();
  return [
    ...universe.slice(0, MOVERS_PER_SIDE).map((row, index) => snap(row, "GAINER", index + 1)),
    ...universe
      .slice(-MOVERS_PER_SIDE)
      .reverse()
      .map((row, index) => snap(row, "LOSER", index + 1)),
  ].filter((row) => {
    if (seen.has(row.symbol)) return false;
    seen.add(row.symbol);
    return true;
  });
}

async function klines(source: Source, symbol: string, interval: Interval): Promise<Candle[]> {
  const rows = (await getJson(
    `${source.base}${source.klinePath}?symbol=${symbol}&interval=${interval}&limit=${KLINE_LIMIT}`,
  )) as unknown;
  if (!Array.isArray(rows)) return [];
  // Drop the newest row: it is still forming, exactly as the app does.
  return rows.slice(0, -1).map((row) => {
    const item = row as [number, string, string, string, string, string];
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

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

type Candidate = {
  symbol: string;
  base: string;
  interval: Interval;
  anchor: number;
  archetype: CaseArchetype;
  side: Side;
  quality: number;
  /** The whole download, shared by reference. Sliced only once selected. */
  series: Candle[];
  snapshot: BoardSnapshot;
};

const windowOf = (candidate: Candidate): Candle[] =>
  candidate.series.slice(candidate.anchor - CASE_CONTEXT_BARS + 1, candidate.anchor + HORIZON + 1);

/** At most this many cases per archetype, so no single lesson dominates. */
const PER_ARCHETYPE = 2;

/**
 * One case per symbol across the whole pack. Six lessons taught on six pieces
 * of tape reads as a curriculum; six lessons on the same symbol reads as one
 * anecdote told six ways.
 */
function select(candidates: Candidate[]): Candidate[] {
  const chosen: Candidate[] = [];
  const usedSymbols = new Set<string>();
  const perArchetype = new Map<CaseArchetype, number>();

  // Best-first, but walk archetypes in a fixed order so every lesson gets its
  // pick before any lesson takes a second one.
  for (let pass = 0; pass < PER_ARCHETYPE; pass += 1) {
    for (const meta of ARCHETYPES) {
      const pool = candidates
        .filter((item) => item.archetype === meta.id && !usedSymbols.has(item.symbol))
        .sort((a, b) => b.quality - a.quality);
      const pick = pool[0];
      if (!pick) continue;
      if ((perArchetype.get(meta.id) ?? 0) >= PER_ARCHETYPE) continue;
      chosen.push(pick);
      usedSymbols.add(pick.symbol);
      perArchetype.set(meta.id, (perArchetype.get(meta.id) ?? 0) + 1);
    }
  }

  const order = new Map(ARCHETYPES.map((meta, index) => [meta.id, index]));
  return chosen.sort(
    (a, b) => (order.get(a.archetype) ?? 0) - (order.get(b.archetype) ?? 0) || b.quality - a.quality,
  );
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const numberText = (value: number) => {
  // Keep the raw precision the exchange published; only strip float noise.
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
};

function candlesText(candles: Candle[]): string {
  return candles
    .map(
      (candle) =>
        `[${candle.time},${numberText(candle.open)},${numberText(candle.high)},` +
        `${numberText(candle.low)},${numberText(candle.close)},${numberText(candle.volume)}]`,
    )
    .join(",");
}

function emit(studies: CaseStudy[], sourceLabel: string, capturedAt: number): string {
  const body = studies
    .map((study) => {
      const board = study.board;
      return `  {
    id: ${JSON.stringify(study.id)},
    symbol: ${JSON.stringify(study.symbol)},
    base: ${JSON.stringify(study.base)},
    interval: ${JSON.stringify(study.interval)},
    source: SOURCE,
    capturedAt: CAPTURED_AT,
    board: { side: ${JSON.stringify(board.side)}, rank: ${board.rank}, changePct: ${numberText(board.changePct)}, quoteVolumeUsd: ${Math.round(board.quoteVolumeUsd)} },
    archetype: ${JSON.stringify(study.archetype)},
    side: ${JSON.stringify(study.side)},
    visibleCount: ${study.visibleCount},
    horizon: ${study.horizon},
    candles: decode([${candlesText(study.candles)}]),
  },`;
    })
    .join("\n");

  return `// GENERATED FILE — do not edit by hand.
//
// Rebuild with:
//   node --experimental-strip-types scripts/build-case-pack.ts
//
// Each entry is a fixed window of real tape, picked off the 24h gainers/losers
// board because it demonstrably contains one specific teaching archetype. The
// screening rules live in \`lib/engine/cases.ts\` and \`tests/engine-cases.test.ts\`
// re-runs them against every window below, so a case that stops matching its
// own label fails the build rather than quietly teaching the wrong thing.
//
// Nothing here is a recommendation, a signal, or a claim about what any of
// these symbols will do next.

import type { CaseStudy } from "../engine/cases.ts";
import type { Candle } from "../engine/types.ts";

/** Where this pack's candles came from. */
export const CASE_PACK_SOURCE = ${JSON.stringify(sourceLabel)};
const SOURCE = CASE_PACK_SOURCE;

/** When the board was read and the tape downloaded, ms epoch. */
export const CASE_PACK_CAPTURED_AT = ${capturedAt};
const CAPTURED_AT = CASE_PACK_CAPTURED_AT;

/** [openTime, open, high, low, close, volume] — packed to keep the bundle small. */
type Row = [number, number, number, number, number, number];

const decode = (rows: Row[]): Candle[] =>
  rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

export const CASE_STUDIES: CaseStudy[] = [
${body}
];
`;
}

// ---------------------------------------------------------------------------

async function main() {
  const { source, tickers } = await resolveSource();
  const movers = board(tickers);
  console.log(
    `榜單 ${movers.length} 檔：`,
    movers.map((row) => `${row.symbol}(${row.snapshot.changePct.toFixed(1)}%)`).join(" "),
  );

  const candidates: Candidate[] = [];
  for (const mover of movers) {
    for (const interval of INTERVALS) {
      let candles: Candle[];
      try {
        candles = await klines(source, mover.symbol, interval);
      } catch (error) {
        console.warn(`  跳過 ${mover.symbol} ${interval}：${(error as Error).message}`);
        continue;
      }
      if (candles.length < CASE_CONTEXT_BARS + HORIZON + 10) continue;
      if (!isContinuousTape(candles, interval)) {
        console.log(`  略過 ${mover.symbol} ${interval}：K 線不連續（非 24/7 交易的標的或缺資料）`);
        continue;
      }

      for (let anchor = CASE_CONTEXT_BARS - 1; anchor <= candles.length - HORIZON - 1; anchor += 1) {
        for (const match of classifyWindow(candles, anchor, HORIZON)) {
          candidates.push({
            symbol: mover.symbol,
            base: mover.symbol.replace(/USDT$/, ""),
            interval,
            anchor,
            archetype: match.archetype,
            side: match.side,
            quality: match.quality,
            series: candles,
            snapshot: mover.snapshot,
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  console.log(`掃描到 ${candidates.length} 個候選窗口。`);

  const capturedAt = Date.now();
  const studies: CaseStudy[] = select(candidates).map((candidate) => ({
    id: `${candidate.archetype.toLowerCase().replace(/_/g, "-")}-${candidate.base.toLowerCase()}-${candidate.interval}`,
    symbol: candidate.symbol,
    base: candidate.base,
    interval: candidate.interval,
    source: source.label,
    capturedAt,
    board: candidate.snapshot,
    archetype: candidate.archetype,
    side: candidate.side,
    candles: windowOf(candidate),
    visibleCount: CASE_CONTEXT_BARS,
    horizon: HORIZON,
  }));

  const problems = studies.flatMap(caseProblems);
  if (problems.length) {
    throw new Error(`產生的教材沒有通過自我檢查：\n  ${problems.join("\n  ")}`);
  }

  for (const study of studies) {
    console.log(
      `  ${study.archetype.padEnd(15)} ${study.symbol.padEnd(12)} ${study.interval}  ` +
        `${study.board.side === "GAINER" ? "漲" : "跌"}幅榜 #${study.board.rank} ` +
        `${study.board.changePct >= 0 ? "+" : ""}${study.board.changePct.toFixed(1)}%`,
    );
  }

  const target = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "market", "casePack.ts");
  writeFileSync(target, emit(studies, source.label, capturedAt), "utf8");
  console.log(`\n已寫入 ${target}（${studies.length} 則教材）。`);
}

await main();
