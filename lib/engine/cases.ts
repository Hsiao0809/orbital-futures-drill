// Case studies: fixed, curated windows of real tape used as teaching material.
//
// The drills slice random windows out of whatever contract the learner picked.
// That is right for practice and wrong for teaching: a lesson needs a specific
// piece of tape that demonstrably contains the thing being taught. This module
// is the screening and description layer for those curated windows.
//
// Two rules hold the material honest:
//
//   1. **Nothing here is authored prose about numbers.** Every figure a learner
//      reads is recomputed from the case's own candles by the same primitives
//      the graders use, so material and grading cannot drift apart. The pack
//      stores candles and a label; it never stores a claim like "fell 6 ATR".
//   2. **A case must still classify as what it claims to be.** `classifyWindow`
//      is used both to find cases and to re-verify them in the tests, so a
//      mislabelled window fails the build rather than teaching the wrong thing.
//
// Candles come from the recent 24h gainers/losers board on purpose. That board
// is where the money-losing behaviour this product exists to prevent actually
// happens: chasing an extended run, sizing a 6%-ATR tape like a 1% one, and
// parking stops inside a range that just tripled in width.

import { atr, forwardOutcome, readStructure, swingPoints, type StructureRead } from "./indicators.ts";
import type { BiasScenario, ExitScenario, StopScenario } from "./drills.ts";
import { invalidationLevel, observableNoise, suggestStop } from "./drills.ts";
import type { Candle, Interval, Side } from "./types.ts";

/** Context bars revealed before the decision point. Matches the drills. */
export const CASE_CONTEXT_BARS = 60;

export type CaseArchetype =
  | "CHASE_TOP"
  | "SWEEP_RECLAIM"
  | "TREND_PULLBACK"
  | "RANGE_CHOP"
  | "GAP_THROUGH"
  | "VOL_EXPANSION";

/** Where the symbol sat on the 24h board when the case was captured. */
export type BoardSnapshot = {
  side: "GAINER" | "LOSER";
  /** 1 = top of that side of the board. */
  rank: number;
  changePct: number;
  quoteVolumeUsd: number;
};

export type CaseStudy = {
  id: string;
  symbol: string;
  /** Display name, e.g. "KAITO". */
  base: string;
  interval: Interval;
  /**
   * Exactly where the candles came from. Stated verbatim in the UI: the perp
   * tape and the spot tape are not the same series, and the material must not
   * imply otherwise.
   */
  source: string;
  /** When the pack was generated, ms epoch. */
  capturedAt: number;
  board: BoardSnapshot;
  archetype: CaseArchetype;
  /** The side the case is argued from. */
  side: Side;
  /** Context bars followed by the hidden bars. */
  candles: Candle[];
  visibleCount: number;
  horizon: number;
};

// ---------------------------------------------------------------------------
// Archetype copy
// ---------------------------------------------------------------------------

export type ArchetypeMeta = {
  id: CaseArchetype;
  title: string;
  /** One line: what the learner is looking at. */
  premise: string;
  /** The specific way this pattern takes money off people. */
  mistake: string;
  /** The transferable rule, stated so it can be applied to other tape. */
  rule: string;
  /** Which drill trains the decision this case turns on. */
  drill: string;
  /** How the case is replayed as a graded scenario. */
  kind: "BIAS" | "STOP" | "EXIT";
};

export const ARCHETYPES: ArchetypeMeta[] = [
  {
    id: "CHASE_TOP",
    title: "追高榜首",
    premise: "一段大漲之後，價格停在整段區間的最上緣——正是漲幅榜把它推到你眼前的時候。",
    mistake:
      "在這裡買進的人，買的是「已經發生的漲幅」。進場價貼著區間頂部，代表停損無論放哪裡都在下方很遠處，" +
      "而上方沒有任何結構可以作為目標。",
    rule:
      "漲幅榜是結果清單，不是進場清單。看到榜單再進場，你拿到的是別人已經吃完的那一段，" +
      "以及接下來的回檔。要參與，等回檔到有結構可以依靠的位置，讓停損有地方放。",
    drill: "bias",
    kind: "BIAS",
  },
  {
    id: "SWEEP_RECLAIM",
    title: "掃損後收回",
    premise: "價格跌破前一個結構低點，把停在那裡的單子清掉，然後收回原本的區間繼續走。",
    mistake:
      "把停損放在「大家都看得到的低點」正下方一點點。那個位置不是保護，是流動性——" +
      "它正好是掃單要去取的地方。",
    rule:
      "停損要放在「到這裡我就看錯了」的結構之外，再加上這個市場當下的雜訊寬度。" +
      "兩個條件缺一個，停損就只是一個被觸發的價格。",
    drill: "stop",
    kind: "STOP",
  },
  {
    id: "TREND_PULLBACK",
    title: "順勢回踩",
    premise: "結構明確的趨勢中出現一次回檔，回到前一段的支撐（或壓力）附近後續攻。",
    mistake:
      "回檔的時候懷疑趨勢結束而離場或反手，等到續攻確認才追——用最差的價格參與最好的行情。",
    rule:
      "回檔幅度要用 ATR 衡量，不是用感覺。趨勢中的正常回檔通常在 1–3 ATR 之間；" +
      "只要結構點沒被真正跌破，回檔就只是回檔。",
    drill: "exit",
    kind: "EXIT",
  },
  {
    id: "RANGE_CHOP",
    title: "無方向的震盪",
    premise: "整段窗口裡，價格往兩邊都走不到 1 ATR。",
    mistake:
      "在這種行情裡持續進出場。每一次都不大虧，但手續費、滑價與心理消耗會累積，" +
      "而且下一筆真正的機會來時，日虧損額度已經被磨掉一半。",
    rule: "沒有方向就是一種判讀結果，不是判讀失敗。不參與是可以拿滿分的答案。",
    drill: "bias",
    kind: "BIAS",
  },
  {
    id: "GAP_THROUGH",
    title: "跳空穿過停損",
    premise: "某一根 K 線直接以遠低於前一根收盤的價格開出，中間沒有任何成交。",
    mistake:
      "以為「我設了停損，所以最多虧 1R」。停損是觸發價，不是成交價；跳空時成交在開盤，虧損會超過計畫。",
    rule:
      "部位大小要用「可能超過 1R」的前提來抓，不是用「剛好 1R」。這也是為什麼考試帳戶的日虧損上限，" +
      "要留出一筆單以上的緩衝。",
    drill: "stop",
    kind: "STOP",
  },
  {
    id: "VOL_EXPANSION",
    title: "波動放大",
    premise: "同一個合約，ATR 在數十根 K 線內放大數倍——這正是它出現在漲跌幅榜上的原因。",
    mistake:
      "沿用波動放大前的口數。風險金額看起來沒變，實際上每一口的波動幅度已經翻了好幾倍，" +
      "同樣的部位變成好幾倍的風險。",
    rule:
      "口數 = 風險金額 ÷ 停損距離。停損距離必須跟著當下的 ATR 走，" +
      "所以波動放大 3 倍時，同樣的風險金額只能下大約三分之一的口數。",
    drill: "sizing",
    // Replayed as a stop question because that is where volatility enters the
    // maths: the stop distance is the divisor in the position-size formula, so
    // "how wide does this tape force my stop" and "how many contracts may I
    // hold" are the same question asked twice.
    kind: "STOP",
  },
];

export function archetypeMeta(id: CaseArchetype): ArchetypeMeta {
  return ARCHETYPES.find((item) => item.id === id) ?? ARCHETYPES[0];
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export const INTERVAL_MS: Record<Interval, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

/**
 * Whether the candles form an unbroken 24/7 series at their stated interval.
 *
 * This is a correctness gate, not tidiness. A tape with holes in it is either
 * an instrument that closes — Binance also lists tokenised equities against
 * USDT, and they sit on the same 24h board — or a series with missing data.
 * Both produce false lessons here: an overnight equity gap is not the crypto
 * gap risk the gap case is about, and every ATR-normalised distance in the
 * material assumes the bars are evenly spaced.
 */
export function isContinuousTape(candles: Candle[], interval: Interval): boolean {
  const step = INTERVAL_MS[interval];
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].time - candles[index - 1].time !== step) return false;
  }
  return true;
}

export type WindowMatch = {
  archetype: CaseArchetype;
  side: Side;
  /**
   * Teaching value, not statistical significance. Higher means the window
   * demonstrates its archetype more legibly.
   */
  quality: number;
};

/** Peaks at `centre`, falling to 0 at `centre ± width`. */
function bell(value: number, centre: number, width: number): number {
  return Math.max(0, 1 - Math.abs(value - centre) / width);
}

/**
 * Beyond this, the ATR measured at the decision point has stopped describing
 * the tape that follows, and every "N ATR" figure in the material becomes
 * theatre — one screened window moved 188 ATR, which is a regime change, not a
 * lesson anyone can act on. Windows like that are rejected outright.
 */
const MAX_EXCURSION_ATR = 15;

/**
 * A gap has to be big enough to matter in money, not just in ATR units. On a
 * tape whose ATR has gone quiet, a routine tick reads as "1.5 ATR" and would
 * dress up a non-event as a lesson about slippage past a stop.
 */
const MIN_GAP_PRICE_PCT = 0.004;

/**
 * Which teaching archetypes, if any, the window ending at `anchor` contains.
 *
 * Used by the pack generator to find cases and by the tests to re-verify the
 * packed ones. A case whose window no longer classifies as its label is a bug,
 * not a stale opinion.
 */
export function classifyWindow(
  candles: Candle[],
  anchor: number,
  horizon: number,
  contextBars = CASE_CONTEXT_BARS,
): WindowMatch[] {
  const matches: WindowMatch[] = [];
  if (anchor < contextBars - 1 || anchor + horizon > candles.length - 1) return matches;

  const range = atr(candles, anchor);
  const close = candles[anchor].close;
  if (!range || !close) return matches;
  // The same liveness floor the drills apply: a flat tape teaches nothing.
  if (range / close < 0.0015) return matches;

  const structure = readStructure(candles, anchor);
  const asLong = forwardOutcome(candles, anchor, horizon, "LONG", 1);
  if (Math.max(asLong.favourableAtr, asLong.adverseAtr) > MAX_EXCURSION_ATR) return matches;
  const visible = candles.slice(anchor - contextBars + 1, anchor + 1);
  const points = swingPoints(visible, 2);
  const lowsBelow = points
    .filter((point) => point.kind === "LOW" && point.price < close)
    .map((point) => point.price)
    .sort((a, b) => b - a);
  const highsAbove = points
    .filter((point) => point.kind === "HIGH" && point.price > close)
    .map((point) => point.price)
    .sort((a, b) => a - b);

  const windowHigh = Math.max(...visible.map((candle) => candle.high));
  const windowLow = Math.min(...visible.map((candle) => candle.low));
  const span = Math.max(windowHigh - windowLow, 1e-12);
  const positionInRange = (close - windowLow) / span;
  const runPct = (close - visible[0].close) / visible[0].close;
  const end = Math.min(candles.length - 1, anchor + horizon);

  // 1. Chasing an extended run at the top of its own range. The lesson needs
  //    the tape to actually punish it, otherwise it is just a scary story.
  if (runPct > 0.12 && positionInRange > 0.85 && asLong.resolvedFirst === "ADVERSE") {
    matches.push({
      archetype: "CHASE_TOP",
      side: "LONG",
      quality:
        30 +
        Math.min(runPct, 0.6) * 50 +
        Math.min(asLong.adverseAtr, 6) * 6 -
        Math.min(asLong.favourableAtr, 3) * 8,
    });
  }

  // 2. A sweep of the nearest structural low that is then reclaimed. Scored for
  //    legibility: the sweep has to be deep enough to take out a stop parked on
  //    the level and shallow enough that a properly placed one survived.
  const nearestLow = lowsBelow[0];
  if (nearestLow !== undefined && asLong.resolvedFirst === "FAVOURABLE") {
    let depth = 0;
    let reclaimed = false;
    for (let index = anchor + 1; index <= end; index += 1) {
      if (candles[index].low < nearestLow) depth = Math.max(depth, (nearestLow - candles[index].low) / range);
      if (depth > 0 && candles[index].close > nearestLow) reclaimed = true;
    }
    if (reclaimed && depth >= 0.15 && depth <= 1.0 && asLong.favourableAtr >= 1.5) {
      matches.push({
        archetype: "SWEEP_RECLAIM",
        side: "LONG",
        quality: 35 + bell(depth, 0.5, 0.5) * 35 + Math.min(asLong.favourableAtr, 4) * 7,
      });
    }
  }

  // 3. Trend continuation off a pullback, with a structure point to lean on.
  if (structure.bias !== "RANGE" && structure.strength >= 0.45) {
    const side: Side = structure.bias === "UPTREND" ? "LONG" : "SHORT";
    const directional = forwardOutcome(candles, anchor, horizon, side, 1);
    const pullback = side === "LONG" ? (windowHigh - close) / range : (close - windowLow) / range;
    const reference = side === "LONG" ? lowsBelow[0] : highsAbove[0];
    if (
      directional.resolvedFirst === "FAVOURABLE" &&
      reference !== undefined &&
      pullback >= 0.7 &&
      pullback <= 3.5
    ) {
      matches.push({
        archetype: "TREND_PULLBACK",
        side,
        quality:
          25 +
          structure.strength * 25 +
          bell(pullback, 1.8, 1.8) * 20 +
          Math.min(directional.favourableAtr, 4) * 8 -
          Math.min(directional.adverseAtr, 3) * 8,
      });
    }
  }

  // 4. Chop: neither side travels a full ATR first.
  if (asLong.resolvedFirst === "NEITHER" && structure.strength < 0.3) {
    matches.push({
      archetype: "RANGE_CHOP",
      side: "LONG",
      quality: 40 + (0.3 - structure.strength) * 80 + (1 - Math.max(asLong.favourableAtr, asLong.adverseAtr)) * 25,
    });
  }

  // 5. A gap through the level a stop would sit at. Measured against the prior
  //    close, since that is the last price at which anything traded.
  {
    let worst = 0;
    let worstPricePct = 0;
    for (let index = anchor + 1; index <= end; index += 1) {
      const gap = candles[index - 1].close - candles[index].open;
      if (gap / range > worst) {
        worst = gap / range;
        worstPricePct = gap / candles[index - 1].close;
      }
    }
    if (worst >= 0.6 && worstPricePct >= MIN_GAP_PRICE_PCT) {
      matches.push({
        archetype: "GAP_THROUGH",
        side: "LONG",
        quality: 40 + Math.min(worst, 2.5) * 20 + Math.min(worstPricePct, 0.05) * 200,
      });
    }
  }

  // 6. Volatility expansion: what a leaderboard entry does to position sizing.
  {
    const before = atr(candles, Math.max(1, anchor - 40));
    const ratio = before > 0 ? range / before : 0;
    if (ratio >= 2.2) {
      matches.push({
        archetype: "VOL_EXPANSION",
        side: structure.bias === "DOWNTREND" ? "SHORT" : "LONG",
        quality: 35 + Math.min(ratio, 6) * 10,
      });
    }
  }

  return matches;
}

/** The best match for `archetype` in this window, if it contains one at all. */
export function matchFor(
  candles: Candle[],
  anchor: number,
  horizon: number,
  archetype: CaseArchetype,
  contextBars = CASE_CONTEXT_BARS,
): WindowMatch | null {
  return (
    classifyWindow(candles, anchor, horizon, contextBars).find((match) => match.archetype === archetype) ?? null
  );
}

// ---------------------------------------------------------------------------
// Replaying a case as a graded scenario
// ---------------------------------------------------------------------------

export function caseAnchor(study: CaseStudy): number {
  return study.visibleCount - 1;
}

export function caseAtr(study: CaseStudy): number {
  return atr(study.candles, caseAnchor(study));
}

export function caseStructure(study: CaseStudy): StructureRead {
  return readStructure(study.candles, caseAnchor(study));
}

/**
 * The wall-clock span the window covers.
 *
 * Worth showing: a case is a slice of the recent tape, not a picture of the
 * last 24 hours. A symbol can sit on the losers' board today on the strength of
 * a window that was still rising when it was captured.
 */
export function caseWindowRange(study: CaseStudy): { from: number; to: number; decisionAt: number } {
  return {
    from: study.candles[0].time,
    to: study.candles[study.candles.length - 1].time,
    decisionAt: study.candles[caseAnchor(study)].time,
  };
}

/** Price at the decision point — the last candle the learner is shown. */
export function caseEntry(study: CaseStudy): number {
  return study.candles[caseAnchor(study)].close;
}

const shared = (study: CaseStudy) => ({
  seed: study.id,
  symbol: study.symbol,
  interval: study.interval,
  candles: study.candles,
  visibleCount: study.visibleCount,
  structure: caseStructure(study),
  atr: caseAtr(study),
  horizon: study.horizon,
});

export function caseBiasScenario(study: CaseStudy): BiasScenario {
  return { kind: "BIAS", id: `case-${study.id}`, ...shared(study) };
}

export function caseStopScenario(study: CaseStudy): StopScenario {
  return { kind: "STOP", id: `case-${study.id}`, ...shared(study), side: study.side, entry: caseEntry(study) };
}

export function caseExitScenario(study: CaseStudy): ExitScenario {
  const entry = caseEntry(study);
  const range = caseAtr(study);
  return {
    kind: "EXIT",
    id: `case-${study.id}`,
    ...shared(study),
    side: study.side,
    entry,
    stop: study.side === "LONG" ? entry - range * 1.2 : entry + range * 1.2,
  };
}

/** The scenario kind this case is argued as, ready to grade. */
export function caseScenario(study: CaseStudy): BiasScenario | StopScenario | ExitScenario {
  const kind = archetypeMeta(study.archetype).kind;
  if (kind === "STOP") return caseStopScenario(study);
  if (kind === "EXIT") return caseExitScenario(study);
  return caseBiasScenario(study);
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export type CaseFact = { label: string; value: string; note?: string };

export type CaseAnalysis = {
  /** Volatility at the decision point. */
  atr: number;
  atrPct: number;
  entry: number;
  structure: StructureRead;
  /** Facts observable at the decision point — what a learner could have known. */
  observable: CaseFact[];
  /** What the hidden candles did. Reported, never used to grade the decision. */
  outcome: CaseFact[];
  /** One line naming the decision the case turns on. */
  question: string;
  /** Levels worth drawing on the chart. */
  lines: Array<{ price: number; label: string; role: "ENTRY" | "STRUCTURE" | "STOP" | "NAIVE" }>;
};

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

/** Enough significant figures for sub-cent alt prices to stay distinguishable. */
export function priceText(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return value.toFixed(decimals);
}

const biasLabel = (structure: StructureRead) =>
  structure.bias === "UPTREND" ? "上升結構" : structure.bias === "DOWNTREND" ? "下降結構" : "區間";

/**
 * Everything the UI says about a case, computed from its candles.
 *
 * Nothing in here is stored in the pack: if the candles change, the description
 * changes with them, and a case can never claim something its tape does not do.
 */
export function describeCase(study: CaseStudy): CaseAnalysis {
  const anchor = caseAnchor(study);
  const range = caseAtr(study);
  const entry = caseEntry(study);
  const structure = caseStructure(study);
  const visible = study.candles.slice(0, study.visibleCount);
  const outcome = forwardOutcome(study.candles, anchor, study.horizon, study.side, 1);
  const end = Math.min(study.candles.length - 1, anchor + study.horizon);

  const windowHigh = Math.max(...visible.map((candle) => candle.high));
  const windowLow = Math.min(...visible.map((candle) => candle.low));
  const runPct = (entry - visible[0].close) / visible[0].close;
  const positionInRange = (entry - windowLow) / Math.max(windowHigh - windowLow, 1e-12);

  const observable: CaseFact[] = [
    {
      label: "結構",
      value: `${biasLabel(structure)}（強度 ${(structure.strength * 100).toFixed(0)}%）`,
      note: "由擺動高低點的堆疊方向與均線斜率算出，只用揭露的 60 根 K 線。",
    },
    {
      label: "ATR",
      value: `${priceText(range)}（${pct(structure.atrPct)} of 價格）`,
      note: "決策當下可觀察到的波動幅度，所有距離都用它換算。",
    },
    {
      label: "區間位置",
      value: `${(positionInRange * 100).toFixed(0)}%`,
      note: `這 60 根的區間是 ${priceText(windowLow)} – ${priceText(windowHigh)}，進場價落在其中的位置。`,
    },
    {
      label: "已經走完的幅度",
      value: `${runPct >= 0 ? "+" : ""}${(runPct * 100).toFixed(1)}%`,
      note: "從揭露窗口的第一根收盤到決策點。這一段是已經發生的，不是你能參與的。",
    },
  ];

  const lines: CaseAnalysis["lines"] = [{ price: entry, label: "決策點", role: "ENTRY" }];
  if (structure.supportBelow !== null) {
    lines.push({ price: structure.supportBelow, label: "結構低點", role: "STRUCTURE" });
  }
  if (structure.resistanceAbove !== null) {
    lines.push({ price: structure.resistanceAbove, label: "結構高點", role: "STRUCTURE" });
  }

  const results: CaseFact[] = [
    {
      label: "順向最大",
      value: `${outcome.favourableAtr.toFixed(2)} ATR`,
      note: `以${study.side === "LONG" ? "做多" : "做空"}計算，後續 ${study.horizon} 根裡最好的浮盈。`,
    },
    {
      label: "逆向最大",
      value: `${outcome.adverseAtr.toFixed(2)} ATR`,
      note: "決定你會不會被掃損的，是這個數字，不是最後收在哪裡。",
    },
    {
      label: "先到哪一邊",
      value:
        outcome.resolvedFirst === "FAVOURABLE"
          ? "順向 1 ATR"
          : outcome.resolvedFirst === "ADVERSE"
            ? "逆向 1 ATR"
            : "兩邊都沒到",
      note: "同一根同時觸及時一律判定逆向先到，跟真實停損一樣。",
    },
    {
      label: `${study.horizon} 根後`,
      value: `${priceText(outcome.finalClose)}（${outcome.driftAtr >= 0 ? "+" : ""}${outcome.driftAtr.toFixed(2)} ATR）`,
    },
  ];

  // Archetype-specific detail, still computed rather than authored.
  let question: string;
  switch (study.archetype) {
    case "CHASE_TOP": {
      question = "漲幅榜把它推到你面前的這一刻，做多的期望值是什麼？";
      break;
    }
    case "SWEEP_RECLAIM": {
      const stopScenario = caseStopScenario(study);
      const level = invalidationLevel(stopScenario);
      const noise = observableNoise(stopScenario);
      const suggested = suggestStop(stopScenario);
      let depth = 0;
      if (level !== undefined) {
        for (let index = anchor + 1; index <= end; index += 1) {
          depth = Math.max(depth, (level - study.candles[index].low) / range);
        }
      }
      observable.push({
        label: "近期最大逆向影線",
        value: `${noise.toFixed(2)} ATR`,
        note: "停損至少要蓋過這個寬度，否則是被日常波動掃掉，不是被行情證明看錯。",
      });
      results.push({
        label: "掃損深度",
        value: `${depth.toFixed(2)} ATR`,
        note:
          level !== undefined
            ? `價格最深跌破結構低點 ${priceText(level)} 達 ${depth.toFixed(2)} ATR，然後收回。停在那個低點上的單子被清掉了。`
            : "這段沒有明確結構點可依。",
      });
      if (level !== undefined) {
        lines.push({ price: level, label: "被掃的低點", role: "NAIVE" });
      }
      lines.push({
        price: suggested.price,
        label: `建議停損 ${suggested.atrUnits.toFixed(2)} ATR`,
        role: "STOP",
      });
      question = `停損放在哪裡，才會在這根掃損之外、又不會大到部位失去意義？`;
      break;
    }
    case "TREND_PULLBACK": {
      const pullback =
        study.side === "LONG" ? (windowHigh - entry) / range : (entry - windowLow) / range;
      observable.push({
        label: "回檔幅度",
        value: `${pullback.toFixed(2)} ATR`,
        note: "趨勢中的正常回檔多半落在 1–3 ATR。用 ATR 衡量，不是用心情。",
      });
      question = "這是趨勢結束，還是趨勢中的一次回檔？";
      break;
    }
    case "RANGE_CHOP": {
      question = "這段行情值得下注嗎？";
      break;
    }
    case "GAP_THROUGH": {
      let worst = 0;
      let at = anchor;
      for (let index = anchor + 1; index <= end; index += 1) {
        const gap = (study.candles[index - 1].close - study.candles[index].open) / range;
        if (gap > worst) {
          worst = gap;
          at = index;
        }
      }
      const from = study.candles[at - 1].close;
      const to = study.candles[at].open;
      results.push({
        label: "跳空",
        value: `${worst.toFixed(2)} ATR（${pct((from - to) / from)}）`,
        note:
          `第 ${at - anchor} 根從 ${priceText(from)} 直接開在 ${priceText(to)}，` +
          "中間沒有成交。停損掛在這兩個價格之間的人，成交在下面那個。",
      });
      lines.push({ price: from, label: "跳空前收盤", role: "STRUCTURE" });
      lines.push({ price: to, label: "跳空後開盤", role: "NAIVE" });
      question = "設了停損，最多就只會虧 1R 嗎？";
      break;
    }
    case "VOL_EXPANSION": {
      const before = atr(study.candles, Math.max(1, anchor - 40));
      const ratio = before > 0 ? range / before : 0;
      const suggested = suggestStop(caseStopScenario(study));
      observable.push({
        label: "ATR 變化",
        value: `${ratio.toFixed(1)}×`,
        note: `40 根之前的 ATR 是 ${priceText(before)}，現在是 ${priceText(range)}。`,
      });
      observable.push({
        label: "現在該有的停損距離",
        value: `${suggested.atrUnits.toFixed(2)} ATR（${priceText(Math.abs(entry - suggested.price))}）`,
        note: suggested.why,
      });
      lines.push({
        price: suggested.price,
        label: `建議停損 ${suggested.atrUnits.toFixed(2)} ATR`,
        role: "STOP",
      });
      results.push({
        label: "同樣風險金額的口數",
        value: `約 ${(ratio > 0 ? 1 / ratio : 0).toFixed(2)} 倍`,
        note:
          "口數 = 風險金額 ÷ 停損距離。停損距離跟著 ATR 放大，所以口數必須等比例縮小；" +
          "沿用舊口數等於把風險放大到原本的數倍。",
      });
      question = "波動放大之後，同樣的風險金額可以下多少口？";
      break;
    }
  }

  return {
    atr: range,
    atrPct: structure.atrPct,
    entry,
    structure,
    observable,
    outcome: results,
    question,
    lines,
  };
}

/** A one-line headline built from the case's own numbers. */
export function caseHeadline(study: CaseStudy): string {
  const meta = archetypeMeta(study.archetype);
  const board = study.board;
  const rank = board.side === "GAINER" ? `漲幅榜第 ${board.rank} 名` : `跌幅榜第 ${board.rank} 名`;
  return `${study.base} · ${rank}（24h ${board.changePct >= 0 ? "+" : ""}${board.changePct.toFixed(1)}%）· ${meta.title}`;
}

/** Validation shared by the generator and the tests. */
export function caseProblems(study: CaseStudy): string[] {
  const problems: string[] = [];
  if (study.candles.length !== study.visibleCount + study.horizon) {
    problems.push(
      `${study.id}: 候選窗口長度 ${study.candles.length} 與 ${study.visibleCount}+${study.horizon} 不符`,
    );
  }
  if (study.visibleCount < CASE_CONTEXT_BARS) {
    problems.push(`${study.id}: 揭露 ${study.visibleCount} 根，少於教材要求的 ${CASE_CONTEXT_BARS} 根`);
  }
  for (const candle of study.candles) {
    if (
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.high < candle.low ||
      candle.high < candle.open ||
      candle.high < candle.close ||
      candle.low > candle.open ||
      candle.low > candle.close
    ) {
      problems.push(`${study.id}: ${new Date(candle.time).toISOString()} 的 OHLC 不自洽`);
      break;
    }
  }
  if (!isContinuousTape(study.candles, study.interval)) {
    problems.push(`${study.id}: K 線時間不連續，不是 24/7 的完整 ${study.interval} 序列`);
  }
  if (!matchFor(study.candles, caseAnchor(study), study.horizon, study.archetype, study.visibleCount)) {
    problems.push(`${study.id}: 這段窗口不再符合 ${study.archetype} 的判定條件`);
  }
  return problems;
}
